import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Foundation

enum AmbientVoiceError: LocalizedError {
    case shortcutRegistrationFailed
    case microphonePermissionDenied
    case emptyTranscript

    var errorDescription: String? {
        switch self {
        case .shortcutRegistrationFailed: return "Could not register the selected global voice shortcut. Check Accessibility and Input Monitoring permissions."
        case .microphonePermissionDenied: return "Microphone permission is required."
        case .emptyTranscript: return "Doubao ASR returned no transcript."
        }
    }
}

enum VoiceShortcutMode: String, Codable, CaseIterable {
    case rightOptionHold
    case keyCombination
}

struct VoiceShortcutConfiguration: Codable, Equatable {
    let mode: VoiceShortcutMode
    let keyCode: UInt32
    let carbonModifiers: UInt32
    let keyLabel: String

    static let defaultValue = VoiceShortcutConfiguration(
        mode: .rightOptionHold,
        keyCode: UInt32(kVK_RightOption),
        carbonModifiers: UInt32(optionKey),
        keyLabel: "Right Option"
    )

    static let optionSpace = VoiceShortcutConfiguration(
        mode: .keyCombination,
        keyCode: UInt32(kVK_Space),
        carbonModifiers: UInt32(optionKey),
        keyLabel: "Space"
    )

    var displayName: String {
        switch mode {
        case .rightOptionHold:
            return "Hold Right Option"
        case .keyCombination:
            return "\(modifierSymbols)\(keyLabel)"
        }
    }

    private var modifierSymbols: String {
        var value = ""
        if carbonModifiers & UInt32(controlKey) != 0 { value += "Control+" }
        if carbonModifiers & UInt32(optionKey) != 0 { value += "Option+" }
        if carbonModifiers & UInt32(shiftKey) != 0 { value += "Shift+" }
        if carbonModifiers & UInt32(cmdKey) != 0 { value += "Command+" }
        return value
    }
}

final class VoiceShortcutStore {
    private let defaults: UserDefaults
    private let key = "metaflow.voiceShortcut.v2"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> VoiceShortcutConfiguration {
        guard let data = defaults.data(forKey: key) else { return .defaultValue }
        do {
            return try JSONDecoder().decode(VoiceShortcutConfiguration.self, from: data)
        } catch {
            NSLog("[metaflow] shortcut.settings_invalid error=%@", error.localizedDescription)
            return .defaultValue
        }
    }

    func save(_ configuration: VoiceShortcutConfiguration) throws {
        defaults.set(try JSONEncoder().encode(configuration), forKey: key)
    }
}

final class GlobalPushToTalk: @unchecked Sendable {
    private let configuration: VoiceShortcutConfiguration
    private let onPress: @MainActor () -> Void
    private let onRelease: @MainActor () -> Void
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private var globalFlagsMonitor: Any?
    private var localFlagsMonitor: Any?
    private var rightOptionDown = false

    init(
        configuration: VoiceShortcutConfiguration,
        onPress: @escaping @MainActor () -> Void,
        onRelease: @escaping @MainActor () -> Void
    ) {
        self.configuration = configuration
        self.onPress = onPress
        self.onRelease = onRelease
    }

    func start() throws {
        guard hotKey == nil, handler == nil, globalFlagsMonitor == nil, localFlagsMonitor == nil else { return }
        if configuration.mode == .rightOptionHold {
            try startRightOptionHold()
            return
        }
        let pointer = Unmanaged.passUnretained(self).toOpaque()
        var eventTypes = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))
        ]
        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            { _, event, userData in
                guard let event, let userData else { return OSStatus(eventNotHandledErr) }
                let monitor = Unmanaged<GlobalPushToTalk>.fromOpaque(userData).takeUnretainedValue()
                monitor.handle(eventKind: GetEventKind(event))
                return noErr
            },
            eventTypes.count,
            &eventTypes,
            pointer,
            &handler
        )
        guard installStatus == noErr else {
            handler = nil
            throw AmbientVoiceError.shortcutRegistrationFailed
        }
        let hotKeyID = EventHotKeyID(signature: Self.signature, id: 1)
        let registerStatus = RegisterEventHotKey(
            configuration.keyCode,
            configuration.carbonModifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKey
        )
        guard registerStatus == noErr else {
            if let handler { RemoveEventHandler(handler) }
            self.handler = nil
            hotKey = nil
            throw AmbientVoiceError.shortcutRegistrationFailed
        }
    }

    func stop() {
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let handler { RemoveEventHandler(handler) }
        hotKey = nil
        handler = nil
        if let globalFlagsMonitor { NSEvent.removeMonitor(globalFlagsMonitor) }
        if let localFlagsMonitor { NSEvent.removeMonitor(localFlagsMonitor) }
        globalFlagsMonitor = nil
        localFlagsMonitor = nil
        rightOptionDown = false
    }

    private func handle(eventKind: UInt32) {
        if eventKind == UInt32(kEventHotKeyPressed) {
            Task { @MainActor in onPress() }
        } else if eventKind == UInt32(kEventHotKeyReleased) {
            Task { @MainActor in onRelease() }
        }
    }

    private func startRightOptionHold() throws {
        globalFlagsMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleRightOption(event)
        }
        localFlagsMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleRightOption(event)
            return event
        }
        if globalFlagsMonitor == nil || localFlagsMonitor == nil {
            stop()
            throw AmbientVoiceError.shortcutRegistrationFailed
        }
    }

    private func handleRightOption(_ event: NSEvent) {
        guard event.keyCode == UInt16(kVK_RightOption) else { return }
        let isDown = event.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.option)
        guard isDown != rightOptionDown else { return }
        rightOptionDown = isDown
        if isDown {
            Task { @MainActor in onPress() }
        } else {
            Task { @MainActor in onRelease() }
        }
    }

    private static let signature: OSType = 0x4D_46_4C_57 // MFLW
}

@MainActor
final class PushToTalkSpeechRecognizer {
    typealias TranscriberFactory = @MainActor () throws -> SpeechTranscriber

    struct Result {
        let transcript: String?
        let locale: String
        let startedAt: String?
        let endedAt: String
        let confidence: Double?
        let error: Error?
    }

    private var transcriber: SpeechTranscriber?
    private var lifecycleTask: Task<Void, Never>?
    private var startedAt: String?
    private var stopRequested = false
    private var ready = false
    private var finishing = false
    private var finish: ((Result) -> Void)?
    private let makeTranscriber: TranscriberFactory

    init(makeTranscriber: @escaping TranscriberFactory = { try SpeechTranscriberFactory.make() }) {
        self.makeTranscriber = makeTranscriber
    }

    func start(
        onReady: @escaping @MainActor () -> Void,
        completion: @escaping @MainActor (Result) -> Void
    ) {
        cancel()
        finish = completion
        stopRequested = false
        ready = false
        finishing = false
        startedAt = isoNow()
        lifecycleTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let transcriber = try self.makeTranscriber()
                self.transcriber = transcriber
                try await transcriber.start()
                guard !Task.isCancelled else { return }
                self.ready = true
                onReady()
                if self.stopRequested { self.finishCurrent() }
            } catch {
                self.complete(transcript: nil, error: error)
            }
        }
    }

    func stop() {
        stopRequested = true
        if ready { finishCurrent() }
    }

    func cancel() {
        lifecycleTask?.cancel()
        lifecycleTask = nil
        transcriber?.cancel()
        transcriber = nil
        finish = nil
        ready = false
        finishing = false
        stopRequested = false
    }

    private func finishCurrent() {
        guard !finishing, let transcriber else { return }
        finishing = true
        lifecycleTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let transcript = normalize(try await transcriber.finish())
                self.complete(
                    transcript: transcript.isEmpty ? nil : transcript,
                    error: transcript.isEmpty ? AmbientVoiceError.emptyTranscript : nil
                )
            } catch {
                self.complete(transcript: nil, error: error)
            }
        }
    }

    private func complete(transcript: String?, error: Error?) {
        guard let finish else { return }
        self.finish = nil
        lifecycleTask = nil
        transcriber = nil
        ready = false
        finishing = false
        finish(Result(
            transcript: transcript,
            locale: Locale.current.identifier,
            startedAt: startedAt,
            endedAt: isoNow(),
            confidence: nil,
            error: error
        ))
    }
}

struct ActiveVoiceSession {
    let id: String
    let eventID: String
    let conversationID: String
    let pressedAt: String
    let snapshot: AccessibilitySnapshot?
    let accessibilityTrusted: Bool
    let screenImage: Task<AmbientScreenImage, Error>
}

struct AmbientDeliveryCard {
    let deliveryID: String
    let requestID: String
    let correlationID: String
    let phase: String
    let surface: String
    let views: [[String: Any]]
    let actions: [String]
    let renderedAt: String

    static func list(from data: Data) throws -> [AmbientDeliveryCard] {
        guard
            let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            root["ok"] as? Bool == true,
            let cards = root["deliveries"] as? [[String: Any]]
        else { throw URLError(.cannotParseResponse) }
        return try cards.map { card in
            guard
                let deliveryID = card["delivery_id"] as? String,
                let renderedAt = card["rendered_at"] as? String,
                let request = card["request"] as? [String: Any],
                let requestID = request["id"] as? String,
                let correlationID = request["correlation_id"] as? String,
                let phase = request["phase"] as? String,
                let surface = request["surface"] as? String
            else { throw URLError(.cannotParseResponse) }
            return AmbientDeliveryCard(
                deliveryID: deliveryID,
                requestID: requestID,
                correlationID: correlationID,
                phase: phase,
                surface: surface,
                views: request["views"] as? [[String: Any]] ?? [],
                actions: request["actions"] as? [String] ?? [],
                renderedAt: renderedAt
            )
        }
    }
}

func requestedAgent(from transcript: String) -> String? {
    let words = transcript.lowercased().split { !$0.isLetter && !$0.isNumber && $0 != "_" && $0 != "-" }
    for candidate in ["codex", "claude_code", "acp_stdio"] where words.contains(Substring(candidate)) {
        return candidate
    }
    return nil
}

func ambientAccessibilityPayload(snapshot: AccessibilitySnapshot?, trusted: Bool) -> [String: Any] {
    guard trusted, let snapshot else {
        return [
            "status": "denied",
            "code": "accessibility_permission_denied",
            "message": "Accessibility permission is required to capture foreground context."
        ]
    }
    var value: [String: Any] = [
        "status": "trusted",
        "app_name": snapshot.appName,
        "bundle_identifier": snapshot.bundleIdentifier,
        "process_id": Int(snapshot.processIdentifier)
    ]
    if let windowTitle = snapshot.windowTitle { value["window_title"] = windowTitle }
    if let role = snapshot.role { value["role"] = role }
    if let subrole = snapshot.subrole { value["subrole"] = subrole }
    if let selectedText = snapshot.selectedText { value["selected_text"] = selectedText }
    if let focusedValue = snapshot.focusedValue { value["focused_value"] = focusedValue }
    if let description = snapshot.description { value["field_description"] = description }
    return value
}

func ambientResultText(_ data: Data) -> String? {
    guard
        let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let view = root["view"] as? [String: Any],
        let representation = view["representation"] as? [String: Any]
    else { return nil }
    let value = representation["value"]
    if let text = value as? String { return text }
    if let object = value as? [String: Any] {
        for key in ["answer", "summary", "text", "message"] {
            if let text = object[key] as? String, !text.isEmpty { return text }
        }
    }
    guard let value, JSONSerialization.isValidJSONObject(value) else { return nil }
    let serialized = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
    return serialized.flatMap { String(data: $0, encoding: .utf8) }
}
