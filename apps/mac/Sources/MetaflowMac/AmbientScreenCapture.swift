import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

struct AmbientScreenImage: Encodable, Sendable {
    let mimeType: String
    let data: Data

    enum CodingKeys: String, CodingKey {
        case mimeType = "mime_type"
        case data
    }
}

enum AmbientScreenCaptureError: LocalizedError {
    case displayUnavailable
    case emptyImage
    case imageTooLarge(Int)

    var errorDescription: String? {
        switch self {
        case .displayUnavailable:
            return "The current display is unavailable to ScreenCaptureKit. Grant Screen Recording permission to Metaflow."
        case .emptyImage:
            return "ScreenCaptureKit returned an empty screen image."
        case .imageTooLarge(let bytes):
            return "The compressed screen image is too large (\(bytes) bytes)."
        }
    }
}

@MainActor
final class AmbientScreenCaptureService {
    func capture(displayID: CGDirectDisplayID?) async throws -> AmbientScreenImage {
        let started = Date()
        NSLog("[metaflow] screen.capture.started display_id=%@", displayID.map(String.init) ?? "automatic")
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = displayID.flatMap({ id in content.displays.first { $0.displayID == id } })
                ?? content.displays.first
            else {
                throw AmbientScreenCaptureError.displayUnavailable
            }
            let ownPID = ProcessInfo.processInfo.processIdentifier
            let ownWindows = content.windows.filter { $0.owningApplication?.processID == ownPID }
            let filter = SCContentFilter(display: display, excludingWindows: ownWindows)
            let configuration = SCStreamConfiguration()
            let scale = min(1, CGFloat(Self.maxEdge) / CGFloat(max(display.width, display.height)))
            configuration.width = max(1, Int((CGFloat(display.width) * scale).rounded()))
            configuration.height = max(1, Int((CGFloat(display.height) * scale).rounded()))
            configuration.showsCursor = true

            let image = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: configuration
            )
            let data = try compressedJPEG(image)
            NSLog(
                "[metaflow] screen.capture.succeeded display_id=%u width=%d height=%d bytes=%d elapsed_ms=%.1f",
                display.displayID,
                configuration.width,
                configuration.height,
                data.count,
                Date().timeIntervalSince(started) * 1_000
            )
            return AmbientScreenImage(mimeType: "image/jpeg", data: data)
        } catch {
            NSLog(
                "[metaflow] screen.capture.failed display_id=%@ elapsed_ms=%.1f error=%@",
                displayID.map(String.init) ?? "automatic",
                Date().timeIntervalSince(started) * 1_000,
                error.localizedDescription
            )
            throw error
        }
    }

    private func compressedJPEG(_ image: CGImage) throws -> Data {
        let bitmap = NSBitmapImageRep(cgImage: image)
        for quality in [0.62, 0.50, 0.40, 0.32] {
            if let data = bitmap.representation(
                using: .jpeg,
                properties: [.compressionFactor: NSNumber(value: quality)]
            ), !data.isEmpty, data.count <= Self.maxBytes {
                return data
            }
        }
        guard let data = bitmap.representation(
            using: .jpeg,
            properties: [.compressionFactor: NSNumber(value: 0.25)]
        ), !data.isEmpty else {
            throw AmbientScreenCaptureError.emptyImage
        }
        guard data.count <= Self.maxBytes else {
            throw AmbientScreenCaptureError.imageTooLarge(data.count)
        }
        return data
    }

    private static var maxEdge: Int {
        guard let raw = LocalEnvironment.value("METAFLOW_SCREEN_MAX_EDGE"),
              let value = Int(raw),
              (800...2_560).contains(value)
        else {
            return 1_440
        }
        return value
    }

    private static let maxBytes = 3_000_000
}

@MainActor
func currentAmbientDisplayID() -> CGDirectDisplayID? {
    let point = NSEvent.mouseLocation
    let screen = NSScreen.screens.first { $0.frame.contains(point) } ?? NSScreen.main
    return (screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
}
