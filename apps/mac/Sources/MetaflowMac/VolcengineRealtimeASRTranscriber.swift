@preconcurrency import AVFoundation
import Foundation
import zlib

struct VolcengineASRConfiguration: Sendable {
    let baseURL: String
    let appKey: String
    let accessToken: String
    let secretKey: String
    let appID: String
    let resourceID: String
    let modelName: String
    let prompt: String

    static func fromEnvironment() throws -> VolcengineASRConfiguration {
        let appKey = (LocalEnvironment.value("VOLCENGINE_ASR_APP_KEY") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let accessToken = (LocalEnvironment.value("VOLCENGINE_ASR_API_KEY") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let secretKey = (LocalEnvironment.value("VOLCENGINE_ASR_SECRET_KEY") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let appID = (LocalEnvironment.value("VOLCENGINE_ASR_APP_ID") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !appKey.isEmpty || (!accessToken.isEmpty && !appID.isEmpty) else {
            throw VolcengineASRError.missingConfiguration
        }
        return VolcengineASRConfiguration(
            baseURL: LocalEnvironment.value("VOLCENGINE_ASR_BASE_URL") ?? "https://openspeech.bytedance.com",
            appKey: appKey,
            accessToken: accessToken,
            secretKey: secretKey,
            appID: appID,
            resourceID: LocalEnvironment.value("VOLCENGINE_ASR_RESOURCE_ID") ?? "volc.seedasr.sauc.duration",
            modelName: LocalEnvironment.value("VOLCENGINE_ASR_MODEL_NAME") ?? "bigmodel",
            prompt: LocalEnvironment.value("VOLCENGINE_ASR_PROMPT") ?? ""
        )
    }
}

@MainActor
final class VolcengineRealtimeASRTranscriber: SpeechTranscriber {
    private let configuration: VolcengineASRConfiguration
    private let audioEngine = AVAudioEngine()
    private var client: VolcengineRealtimeASRClient?
    private var latestTranscript = ""
    private var eventsTask: Task<Void, Never>?
    private var frameBuffer: VolcengineAudioFrameBuffer?

    init(configuration: VolcengineASRConfiguration) {
        self.configuration = configuration
    }

    func start() async throws {
        stopAudio()
        if let client {
            Task {
                await client.close()
            }
        }

        let client = VolcengineRealtimeASRClient(configuration: configuration)
        self.client = client
        latestTranscript = ""
        eventsTask?.cancel()
        let frameBuffer = VolcengineAudioFrameBuffer()
        self.frameBuffer = frameBuffer
        try startAudio(frameBuffer: frameBuffer)
        eventsTask = Task { [weak self] in
            guard let self else { return }
            for await event in client.events {
                await MainActor.run {
                    switch event {
                    case .partial(let text), .final(let text):
                        self.latestTranscript = text
                    case .failed(let message):
                        self.latestTranscript = message
                    }
                }
            }
        }
        do {
            try await client.connect()
            await frameBuffer.attach(client: client)
        } catch {
            stopAudio()
            await frameBuffer.cancel()
            eventsTask?.cancel()
            eventsTask = nil
            self.frameBuffer = nil
            self.client = nil
            await client.close()
            throw error
        }
    }

    func finish() async throws -> String {
        stopAudio()
        guard let client else {
            throw VolcengineASRError.notConnected
        }
        let frameBuffer = frameBuffer
        defer {
            eventsTask?.cancel()
            eventsTask = nil
            self.frameBuffer = nil
            self.client = nil
        }
        let stats = try await frameBuffer?.finishRecording() ?? VolcengineAudioStats()
        guard stats.frameCount > 0, stats.byteCount > 0 else {
            throw VolcengineASRError.audioFramesUnavailable
        }
        do {
            try await client.finishInputIfNeeded()
        } catch {
            if latestTranscript.isEmpty {
                throw error
            }
        }
        let finalText = try await client.awaitFinalResult(
            timeoutSeconds: 4.0,
            partialGraceSeconds: Self.partialGraceSeconds
        )
        let transcript = finalText.isEmpty ? latestTranscript : finalText
        guard !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw VolcengineASRError.emptyTranscript(
                frames: stats.frameCount,
                bytes: stats.byteCount,
                peak: stats.peakAmplitude
            )
        }
        NSLog(
            "[metaflow] doubao.asr.completed frames=%d bytes=%d peak=%d",
            stats.frameCount,
            stats.byteCount,
            stats.peakAmplitude
        )
        return transcript
    }

    func cancel() {
        stopAudio()
        let frameBuffer = frameBuffer
        self.frameBuffer = nil
        Task {
            await frameBuffer?.cancel()
        }
        eventsTask?.cancel()
        eventsTask = nil
        let client = client
        self.client = nil
        Task {
            await client?.close()
        }
    }

    private func startAudio(frameBuffer: VolcengineAudioFrameBuffer) throws {
        let inputNode = audioEngine.inputNode
        inputNode.removeTap(onBus: 0)
        let inputFormat = inputNode.outputFormat(forBus: 0)
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16_000,
            channels: 1,
            interleaved: true
        ) else {
            throw VolcengineASRError.audioFormatUnavailable
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw VolcengineASRError.audioConverterUnavailable
        }

        let sink = VolcengineAudioFrameSink(buffer: frameBuffer, converter: converter, targetFormat: targetFormat)
        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: inputFormat, block: Self.makeAudioTap(sink: sink))

        audioEngine.prepare()
        try audioEngine.start()
    }

    private func stopAudio() {
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
    }

    private static var partialGraceSeconds: Double {
        guard let raw = LocalEnvironment.value("VOLCENGINE_ASR_PARTIAL_GRACE_MS"),
              let milliseconds = Double(raw)
        else {
            return 0.45
        }
        return min(max(milliseconds, 0), 2_000) / 1_000
    }

    private nonisolated static func makeAudioTap(
        sink: VolcengineAudioFrameSink
    ) -> @Sendable (AVAudioPCMBuffer, AVAudioTime) -> Void {
        { buffer, _ in
            sink.send(buffer)
        }
    }

    fileprivate nonisolated static func convert(
        inputProvider: SingleBufferInputProvider,
        converter: AVAudioConverter,
        targetFormat: AVAudioFormat
    ) -> Data? {
        let ratio = targetFormat.sampleRate / inputProvider.inputSampleRate
        let outputCapacity = AVAudioFrameCount(Double(inputProvider.inputFrameLength) * ratio) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outputCapacity) else {
            return nil
        }
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            inputProvider.provide(status: status)
        }
        guard error == nil, let data = output.int16ChannelData else {
            return nil
        }
        return Data(bytes: data[0], count: Int(output.frameLength) * MemoryLayout<Int16>.size)
    }
}

private final class SingleBufferInputProvider: @unchecked Sendable {
    private let buffer: AVAudioPCMBuffer
    private var didProvideInput = false

    var inputSampleRate: Double {
        buffer.format.sampleRate
    }

    var inputFrameLength: AVAudioFrameCount {
        buffer.frameLength
    }

    init(buffer: AVAudioPCMBuffer) {
        self.buffer = buffer
    }

    func provide(status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
        if didProvideInput {
            status.pointee = .noDataNow
            return nil
        }
        didProvideInput = true
        status.pointee = .haveData
        return buffer
    }
}

private final class VolcengineWebSocketOpenDelegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var didOpen = false
    private var waiters: [CheckedContinuation<Void, Error>] = []

    func waitForOpen(timeoutSeconds: Double) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            defer {
                group.cancelAll()
            }
            group.addTask {
                try await self.waitForOpenSignal()
            }
            group.addTask {
                try await Task.sleep(for: .milliseconds(Int(timeoutSeconds * 1_000)))
                throw VolcengineASRError.timeout
            }
            try await group.next()
        }
    }

    private func waitForOpenSignal() async throws {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if didOpen {
                lock.unlock()
                continuation.resume()
            } else {
                waiters.append(continuation)
                lock.unlock()
            }
        }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        lock.lock()
        didOpen = true
        let continuations = waiters
        waiters.removeAll()
        lock.unlock()
        for continuation in continuations {
            continuation.resume()
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        guard let error else { return }
        lock.lock()
        let continuations = waiters
        waiters.removeAll()
        lock.unlock()
        for continuation in continuations {
            continuation.resume(throwing: error)
        }
    }
}

private struct VolcengineAudioStats: Sendable {
    var frameCount = 0
    var byteCount = 0
    var peakAmplitude = 0
}

private actor VolcengineAudioFrameBuffer {
    private var client: VolcengineRealtimeASRClient?
    private var queuedFrames: [Data] = []
    private var isRecording = true
    private let maxQueuedBytes: Int
    private var queuedBytes = 0
    private var stats = VolcengineAudioStats()
    private var sendFailure: String?

    init(maxQueuedBytes: Int = 2_000_000) {
        self.maxQueuedBytes = maxQueuedBytes
    }

    func append(_ frame: Data) async {
        guard isRecording else { return }
        stats.frameCount += 1
        stats.byteCount += frame.count
        stats.peakAmplitude = max(stats.peakAmplitude, peakAmplitude(in: frame))
        if let client {
            do {
                try await client.sendPCM16LEFrame(frame)
            } catch {
                sendFailure = error.localizedDescription
                await client.reportTransportFailure(error.localizedDescription)
            }
            return
        }

        queuedFrames.append(frame)
        queuedBytes += frame.count
        while queuedBytes > maxQueuedBytes, !queuedFrames.isEmpty {
            queuedBytes -= queuedFrames.removeFirst().count
        }
    }

    func attach(client: VolcengineRealtimeASRClient) async {
        self.client = client
        let frames = queuedFrames
        queuedFrames.removeAll()
        queuedBytes = 0
        for frame in frames {
            guard isRecording else { return }
            do {
                try await client.sendPCM16LEFrame(frame)
            } catch {
                sendFailure = error.localizedDescription
                await client.reportTransportFailure(error.localizedDescription)
                return
            }
        }
    }

    func finishRecording() async throws -> VolcengineAudioStats {
        isRecording = false
        guard let client else {
            queuedFrames.removeAll()
            queuedBytes = 0
            if let sendFailure { throw VolcengineASRError.frameSendFailed(sendFailure) }
            return stats
        }
        let frames = queuedFrames
        queuedFrames.removeAll()
        queuedBytes = 0
        for frame in frames {
            do {
                try await client.sendPCM16LEFrame(frame)
            } catch {
                sendFailure = error.localizedDescription
                await client.reportTransportFailure(error.localizedDescription)
                break
            }
        }
        if let sendFailure { throw VolcengineASRError.frameSendFailed(sendFailure) }
        return stats
    }

    func cancel() async {
        isRecording = false
        queuedFrames.removeAll()
        queuedBytes = 0
        client = nil
    }

    private func peakAmplitude(in frame: Data) -> Int {
        frame.withUnsafeBytes { bytes in
            bytes.bindMemory(to: Int16.self).reduce(into: 0) { peak, sample in
                peak = max(peak, abs(Int(Int32(sample))))
            }
        }
    }
}

private final class VolcengineAudioFrameSink: @unchecked Sendable {
    private let frameBuffer: VolcengineAudioFrameBuffer
    private let converter: AVAudioConverter
    private let targetFormat: AVAudioFormat

    init(buffer: VolcengineAudioFrameBuffer, converter: AVAudioConverter, targetFormat: AVAudioFormat) {
        self.frameBuffer = buffer
        self.converter = converter
        self.targetFormat = targetFormat
    }

    func send(_ buffer: AVAudioPCMBuffer) {
        let inputProvider = SingleBufferInputProvider(buffer: buffer)
        guard let pcm = VolcengineRealtimeASRTranscriber.convert(
            inputProvider: inputProvider,
            converter: converter,
            targetFormat: targetFormat
        ) else {
            return
        }
        Task {
            await frameBuffer.append(pcm)
        }
    }
}

actor VolcengineRealtimeASRClient {
    enum Event: Sendable {
        case partial(String)
        case final(String)
        case failed(String)
    }

    nonisolated let events: AsyncStream<Event>
    private let continuation: AsyncStream<Event>.Continuation
    private let configuration: VolcengineASRConfiguration
    private var session: URLSession?
    private var openDelegate: VolcengineWebSocketOpenDelegate?
    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var pendingPCM = Data()
    private var nextSequence: Int32 = 2
    private var requestID = UUID().uuidString
    private var latestText = ""
    private var finalText = ""
    private var terminalError: Error?
    private var finishSent = false
    private var completedReceived = false

    init(configuration: VolcengineASRConfiguration) {
        self.configuration = configuration
        var continuation: AsyncStream<Event>.Continuation!
        self.events = AsyncStream { continuation = $0 }
        self.continuation = continuation
    }

    func connect() async throws {
        requestID = UUID().uuidString
        finishSent = false
        finalText = ""
        latestText = ""
        terminalError = nil
        completedReceived = false
        pendingPCM.removeAll()
        nextSequence = 2

        var request = URLRequest(url: try VolcengineASRProtocol.webSocketURL(from: configuration.baseURL))
        request.timeoutInterval = 20
        for (header, value) in VolcengineASRProtocol.headers(configuration: configuration, requestID: requestID) {
            request.setValue(value, forHTTPHeaderField: header)
        }
        let openDelegate = VolcengineWebSocketOpenDelegate()
        let session = URLSession(configuration: .default, delegate: openDelegate, delegateQueue: nil)
        let task = session.webSocketTask(with: request)
        self.openDelegate = openDelegate
        self.session = session
        self.task = task
        task.resume()
        do {
            try await openDelegate.waitForOpen(timeoutSeconds: 6.0)
            try await sendStartFrameWithRetry(requestID: requestID)
            try await waitForAck(timeoutSeconds: 3.0)
            receiveTask = Task { [weak self] in
                await self?.receiveLoop()
            }
        } catch {
            await close()
            throw error
        }
    }

    func sendPCM16LEFrame(_ frame: Data) async throws {
        guard !finishSent else { return }
        let chunks = VolcengineASRProtocol.appendAndChunkPCM(
            pending: &pendingPCM,
            incoming: frame,
            flushTail: false
        )
        for chunk in chunks {
            try await send(.data(VolcengineASRProtocol.audioFrame(sequence: nextSequence, chunk: chunk, isFinal: false)))
            nextSequence += 1
        }
    }

    func reportTransportFailure(_ message: String) {
        guard terminalError == nil else { return }
        let error = VolcengineASRError.frameSendFailed(message)
        terminalError = error
        continuation.yield(.failed(error.localizedDescription))
    }

    func finishInputIfNeeded() async throws {
        guard !finishSent else { return }
        if terminalError != nil || completedReceived || !finalText.isEmpty {
            finishSent = true
            return
        }
        guard task != nil else {
            if latestText.isEmpty {
                throw VolcengineASRError.notConnected
            }
            finishSent = true
            return
        }
        let chunks = VolcengineASRProtocol.appendAndChunkPCM(
            pending: &pendingPCM,
            incoming: Data(),
            flushTail: true
        )
        if chunks.isEmpty {
            do {
                try await send(.data(VolcengineASRProtocol.audioFrame(sequence: nextSequence, chunk: Data(), isFinal: true)))
                nextSequence += 1
            } catch {
                if latestText.isEmpty {
                    throw error
                }
            }
        } else {
            for (index, chunk) in chunks.enumerated() {
                let isFinal = index == chunks.count - 1
                do {
                    try await send(.data(VolcengineASRProtocol.audioFrame(sequence: nextSequence, chunk: chunk, isFinal: isFinal)))
                    nextSequence += 1
                } catch {
                    if latestText.isEmpty {
                        throw error
                    }
                    break
                }
            }
        }
        finishSent = true
    }

    func awaitFinalResult(timeoutSeconds: Double, partialGraceSeconds: Double) async throws -> String {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        let partialDeadline = Date().addingTimeInterval(partialGraceSeconds)
        while Date() < deadline {
            if let terminalError {
                throw terminalError
            }
            if !finalText.isEmpty {
                await close()
                return finalText
            }
            if completedReceived {
                await close()
                return latestText
            }
            if !latestText.isEmpty, Date() >= partialDeadline {
                await close()
                return latestText
            }
            try await Task.sleep(for: .milliseconds(40))
        }
        await close()
        return latestText
    }

    func close() async {
        receiveTask?.cancel()
        receiveTask = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        openDelegate = nil
    }

    private func waitForAck(timeoutSeconds: Double) async throws {
        guard let task else { throw VolcengineASRError.notConnected }
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            let message = try await task.receive()
            guard case .data(let data) = message else { continue }
            let event = try VolcengineASRProtocol.parse(data)
            switch event {
            case .acknowledged:
                return
            case .failed(let code, let message):
                throw VolcengineASRError.server("\(code): \(message)")
            case .partial(let text):
                latestText = text
                continuation.yield(.partial(text))
            case .final(let text):
                finalText = text
                continuation.yield(.final(text))
            case .completed, .ignored:
                return
            }
        }
        throw VolcengineASRError.timeout
    }

    private func receiveLoop() async {
        guard let task else { return }
        while !Task.isCancelled {
            do {
                let message = try await task.receive()
                let data: Data
                switch message {
                case .data(let payload):
                    data = payload
                case .string(let text):
                    data = Data(text.utf8)
                @unknown default:
                    continue
                }
                switch try VolcengineASRProtocol.parse(data) {
                case .acknowledged, .ignored:
                    break
                case .partial(let text):
                    latestText = text
                    continuation.yield(.partial(text))
                case .final(let text):
                    finalText = text
                    continuation.yield(.final(text))
                case .completed:
                    completedReceived = true
                case .failed(let code, let message):
                    let error = VolcengineASRError.server("\(code): \(message)")
                    terminalError = error
                    continuation.yield(.failed(error.localizedDescription))
                    return
                }
            } catch {
                if !finishSent {
                    terminalError = error
                    continuation.yield(.failed(error.localizedDescription))
                }
                return
            }
        }
    }

    private func send(_ message: URLSessionWebSocketTask.Message) async throws {
        guard let task else { throw VolcengineASRError.notConnected }
        try await task.send(message)
    }

    private func sendStartFrameWithRetry(requestID: String) async throws {
        let frame = try VolcengineASRProtocol.startFrame(configuration: configuration, requestID: requestID)
        do {
            try await send(.data(frame))
        } catch {
            try await Task.sleep(for: .milliseconds(160))
            try await send(.data(frame))
        }
    }
}

enum VolcengineASRProtocol {
    enum ServerEvent {
        case acknowledged
        case partial(String)
        case final(String)
        case completed
        case failed(String, String)
        case ignored
    }

    static let chunkSize = 3_200

    static func webSocketURL(from raw: String) throws -> URL {
        let candidate = raw.contains("://") ? raw : "https://\(raw)"
        guard var components = URLComponents(string: candidate), components.host != nil else {
            throw VolcengineASRError.invalidEndpoint
        }
        switch components.scheme?.lowercased() {
        case "https":
            components.scheme = "wss"
        case "http":
            components.scheme = "ws"
        case "wss", "ws":
            break
        default:
            throw VolcengineASRError.invalidEndpoint
        }
        if components.path.isEmpty || components.path == "/" || components.path == "/api/v3" || components.path == "/api/v3/audio/transcriptions" {
            components.path = "/api/v3/sauc/bigmodel"
        }
        guard let url = components.url else { throw VolcengineASRError.invalidEndpoint }
        return url
    }

    static func headers(configuration: VolcengineASRConfiguration, requestID: String) -> [String: String] {
        let commonHeaders = [
            "X-Api-Resource-Id": configuration.resourceID,
            "X-Api-Request-Id": requestID,
            "X-Api-Sequence": "-1",
            "X-Api-Connect-Id": requestID
        ]
        if !configuration.appKey.isEmpty {
            return commonHeaders.merging(["X-Api-Key": configuration.appKey]) { current, _ in current }
        }
        return commonHeaders.merging([
            "X-Api-App-Key": configuration.appID,
            "X-Api-Access-Key": configuration.accessToken
        ]) { current, _ in current }
    }

    static func startFrame(configuration: VolcengineASRConfiguration, requestID: String) throws -> Data {
        var requestPayload: [String: Any] = [
            "model_name": configuration.modelName,
            "enable_itn": true,
            "enable_punc": true
        ]
        if !configuration.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            requestPayload["context"] = configuration.prompt
        }
        let payload: [String: Any] = [
            "user": ["uid": requestID],
            "audio": [
                "format": "pcm",
                "rate": 16_000,
                "bits": 16,
                "channel": 1,
                "codec": "raw"
            ],
            "request": requestPayload
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [])
        let compressed = try gzip(data)
        // Volcengine's demo and server-side auto sequence count the full client
        // request as sequence 1, so audio frames must start at sequence 2.
        return Data([0x11, 0x11, 0x11, 0x00])
            + int32Data(1)
            + uint32Data(UInt32(compressed.count))
            + compressed
    }

    static func audioFrame(sequence: Int32, chunk: Data, isFinal: Bool) -> Data {
        let value = isFinal ? -max(Int32(1), abs(sequence)) : max(Int32(1), abs(sequence))
        let flags: UInt8 = isFinal ? 0x3 : 0x1
        let payload = (try? gzip(chunk)) ?? chunk
        return Data([0x11, 0x20 | flags, 0x01, 0x00])
            + int32Data(value)
            + uint32Data(UInt32(payload.count))
            + payload
    }

    static func appendAndChunkPCM(pending: inout Data, incoming: Data, flushTail: Bool) -> [Data] {
        pending.append(incoming)
        var chunks: [Data] = []
        while pending.count >= chunkSize {
            chunks.append(Data(pending.prefix(chunkSize)))
            pending.removeFirst(chunkSize)
        }
        if flushTail, !pending.isEmpty {
            chunks.append(pending)
            pending.removeAll()
        }
        return chunks
    }

    static func parse(_ data: Data) throws -> ServerEvent {
        let bytes = [UInt8](data)
        guard bytes.count >= 4, bytes[0] >> 4 == 0x1 else {
            throw VolcengineASRError.invalidMessage
        }
        let headerLength = Int(bytes[0] & 0x0F) * 4
        guard bytes.count >= headerLength else { throw VolcengineASRError.invalidMessage }
        let messageType = bytes[1] >> 4
        let flags = bytes[1] & 0x0F
        let serialization = bytes[2] >> 4
        let compression = bytes[2] & 0x0F

        var cursor = headerLength
        if messageType == 0xF {
            let code = uint32(at: cursor, in: bytes).map(String.init) ?? "unknown"
            cursor += bytes.count >= cursor + 4 ? 4 : 0
            guard let length = uint32(at: cursor, in: bytes) else {
                return .failed(code, "Volcengine ASR server error.")
            }
            cursor += 4
            let end = min(bytes.count, cursor + Int(length))
            let message = cursor < end ? String(decoding: bytes[cursor..<end], as: UTF8.self) : "Volcengine ASR server error."
            return .failed(code, message)
        }

        var sequence: Int32?
        if [0x9, 0xB].contains(messageType), [0x1, 0x3].contains(flags), bytes.count >= cursor + 4 {
            sequence = int32(at: cursor, in: bytes)
            cursor += 4
        }
        var payload = Data()
        if bytes.count >= cursor + 4, let length = uint32(at: cursor, in: bytes) {
            cursor += 4
            if bytes.count >= cursor + Int(length) {
                payload = Data(bytes[cursor..<(cursor + Int(length))])
            }
        }
        if compression == 1 {
            payload = try gunzip(payload)
        } else if compression != 0 {
            throw VolcengineASRError.unsupportedCompression
        }

        let object = serialization == 1 ? jsonObject(payload) : nil
        if messageType == 0xB {
            if let failure = failure(from: object) {
                return .failed(failure.0, failure.1)
            }
            return .acknowledged
        }
        guard messageType == 0x9 else { return .ignored }
        if let failure = failure(from: object) {
            return .failed(failure.0, failure.1)
        }
        let text = transcript(from: object).trimmingCharacters(in: .whitespacesAndNewlines)
        let isFinal = (sequence ?? 0) < 0 || flags == 0x2 || flags == 0x3 || (object?["is_final"] as? Bool == true)
        if text.isEmpty {
            return isFinal ? .completed : .ignored
        }
        return isFinal ? .final(text) : .partial(text)
    }

    private static func jsonObject(_ data: Data) -> [String: Any]? {
        guard !data.isEmpty else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
    }

    private static func failure(from object: [String: Any]?) -> (String, String)? {
        guard let object else { return nil }
        if let code = object["error_code"] {
            return (String(describing: code), object["error_message"] as? String ?? "Volcengine ASR error.")
        }
        if let code = object["code"] {
            return (String(describing: code), object["message"] as? String ?? "Volcengine ASR error.")
        }
        return nil
    }

    private static func transcript(from object: [String: Any]?) -> String {
        guard let object else { return "" }
        if let result = object["result"] as? [String: Any] {
            if let text = result["text"] as? String { return text }
            if let utterances = result["utterances"] as? [[String: Any]] {
                return utterances.compactMap { $0["text"] as? String }.joined()
            }
        }
        if let text = object["text"] as? String { return text }
        return ""
    }

    private static func gzip(_ data: Data) throws -> Data {
        var input = data
        return try input.withUnsafeMutableBytes { sourceBuffer in
            let sourcePointer = sourceBuffer.bindMemory(to: Bytef.self).baseAddress
            var stream = z_stream()
            let initStatus = deflateInit2_(
                &stream,
                Z_DEFAULT_COMPRESSION,
                Z_DEFLATED,
                MAX_WBITS + 16,
                8,
                Z_DEFAULT_STRATEGY,
                ZLIB_VERSION,
                Int32(MemoryLayout<z_stream>.size)
            )
            guard initStatus == Z_OK else { throw VolcengineASRError.compressionFailed }
            defer { deflateEnd(&stream) }

            stream.next_in = sourcePointer
            stream.avail_in = uInt(data.count)

            var output = Data()
            let chunkSize = 16_384
            repeat {
                var buffer = [UInt8](repeating: 0, count: chunkSize)
                let status = buffer.withUnsafeMutableBytes { outputBuffer in
                    stream.next_out = outputBuffer.bindMemory(to: Bytef.self).baseAddress
                    stream.avail_out = uInt(chunkSize)
                    return deflate(&stream, Z_FINISH)
                }
                guard status == Z_OK || status == Z_STREAM_END else {
                    throw VolcengineASRError.compressionFailed
                }
                output.append(buffer, count: chunkSize - Int(stream.avail_out))
                if status == Z_STREAM_END { break }
            } while stream.avail_out == 0
            return output
        }
    }

    private static func gunzip(_ data: Data) throws -> Data {
        guard !data.isEmpty else { return Data() }
        return try data.withUnsafeBytes { sourceBuffer in
            guard let sourcePointer = sourceBuffer.bindMemory(to: Bytef.self).baseAddress else {
                return Data()
            }
            var stream = z_stream()
            let initStatus = inflateInit2_(
                &stream,
                MAX_WBITS + 16,
                ZLIB_VERSION,
                Int32(MemoryLayout<z_stream>.size)
            )
            guard initStatus == Z_OK else { throw VolcengineASRError.compressionFailed }
            defer { inflateEnd(&stream) }

            stream.next_in = UnsafeMutablePointer<Bytef>(mutating: sourcePointer)
            stream.avail_in = uInt(data.count)

            var output = Data()
            let chunkSize = 16_384
            while true {
                var buffer = [UInt8](repeating: 0, count: chunkSize)
                let status = buffer.withUnsafeMutableBytes { outputBuffer in
                    stream.next_out = outputBuffer.bindMemory(to: Bytef.self).baseAddress
                    stream.avail_out = uInt(chunkSize)
                    return inflate(&stream, Z_NO_FLUSH)
                }
                guard status == Z_OK || status == Z_STREAM_END else {
                    throw VolcengineASRError.compressionFailed
                }
                output.append(buffer, count: chunkSize - Int(stream.avail_out))
                if status == Z_STREAM_END { break }
            }
            return output
        }
    }

    private static func uint32Data(_ value: UInt32) -> Data {
        var bigEndian = value.bigEndian
        return Data(bytes: &bigEndian, count: MemoryLayout<UInt32>.size)
    }

    private static func int32Data(_ value: Int32) -> Data {
        var bigEndian = value.bigEndian
        return Data(bytes: &bigEndian, count: MemoryLayout<Int32>.size)
    }

    private static func uint32(at offset: Int, in bytes: [UInt8]) -> UInt32? {
        guard bytes.count >= offset + 4 else { return nil }
        return UInt32(bytes[offset]) << 24
            | UInt32(bytes[offset + 1]) << 16
            | UInt32(bytes[offset + 2]) << 8
            | UInt32(bytes[offset + 3])
    }

    private static func int32(at offset: Int, in bytes: [UInt8]) -> Int32? {
        guard let raw = uint32(at: offset, in: bytes) else { return nil }
        return Int32(bitPattern: raw)
    }
}

enum VolcengineASRError: LocalizedError {
    case missingConfiguration
    case invalidEndpoint
    case invalidMessage
    case unsupportedCompression
    case audioFormatUnavailable
    case audioConverterUnavailable
    case audioFramesUnavailable
    case emptyTranscript(frames: Int, bytes: Int, peak: Int)
    case frameSendFailed(String)
    case notConnected
    case timeout
    case compressionFailed
    case server(String)

    var errorDescription: String? {
        switch self {
        case .missingConfiguration:
            return "Doubao ASR is not configured. Set VOLCENGINE_ASR_APP_KEY or VOLCENGINE_ASR_API_KEY plus VOLCENGINE_ASR_APP_ID."
        case .invalidEndpoint:
            return "Invalid Volcengine ASR endpoint."
        case .invalidMessage:
            return "Invalid Volcengine ASR message."
        case .unsupportedCompression:
            return "Unsupported Volcengine ASR compression."
        case .audioFormatUnavailable:
            return "Could not create the ASR audio format."
        case .audioConverterUnavailable:
            return "Could not create the ASR audio converter."
        case .audioFramesUnavailable:
            return "Doubao ASR received no microphone audio frames."
        case .emptyTranscript(let frames, let bytes, let peak):
            return "Doubao ASR returned no transcript after \(frames) microphone frames (\(bytes) bytes, peak \(peak))."
        case .frameSendFailed(let message):
            return "Doubao ASR audio frame send failed: \(message)"
        case .notConnected:
            return "Volcengine ASR is not connected."
        case .timeout:
            return "Volcengine ASR timed out."
        case .compressionFailed:
            return "Volcengine ASR compression failed."
        case .server(let message):
            return "Volcengine ASR server error: \(message)"
        }
    }
}
