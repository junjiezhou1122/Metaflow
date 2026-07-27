import Foundation

struct AmbientAssistClient {
    let endpoint: URL
    let conversationID: String
    let token: String?
    var session: URLSession

    init(
        endpoint: URL,
        conversationID: String = "metaflow-notch",
        token: String? = nil,
        session: URLSession = .shared
    ) {
        self.endpoint = endpoint
        self.conversationID = conversationID
        self.token = token
        self.session = session
    }

    func assist(
        requestID: String,
        conversationID: String? = nil,
        prompt: String,
        source: AmbientAssistSource,
        transcript: String?,
        snapshot: AccessibilitySnapshot?,
        screenImage: AmbientScreenImage,
        agent: AgentBackendConfiguration,
        onDelta: @escaping @MainActor (String) -> Void = { _ in },
        onToolActivity: @escaping @MainActor (AmbientToolActivityEvent) -> Void = { _ in }
    ) async throws -> AmbientAssistResult {
        let unsignedRequest = try makeRequest(
            requestID: requestID,
            conversationID: conversationID,
            prompt: prompt,
            source: source,
            transcript: transcript,
            snapshot: snapshot,
            screenImage: screenImage,
            agent: agent
        )
        guard let token else { throw ResidentOperationAccessError.invalidToken }
        let access = try ResidentOperationAccessClient(endpoint: endpoint, token: token, session: session)
        let request = try await access.authorize(unsignedRequest)
        let started = Date()
        NSLog("[metaflow] ambient.assist.started request_id=%@ source=%@", requestID, source.rawValue)
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw AmbientAssistClientError.missingHTTPResponse
            }
            guard (200..<300).contains(http.statusCode) else {
                let data = try await collect(bytes: bytes)
                let envelope = try? JSONDecoder().decode(AmbientAssistResponse.self, from: data)
                throw AmbientAssistClientError.rejected(
                    status: http.statusCode,
                    code: envelope?.code,
                    message: envelope?.error ?? String(data: data, encoding: .utf8) ?? "Unknown response"
                )
            }
            var result: AmbientAssistResult?
            var firstDeltaLogged = false
            for try await line in bytes.lines {
                guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                let event: AmbientAssistStreamEvent
                do {
                    event = try JSONDecoder().decode(AmbientAssistStreamEvent.self, from: Data(line.utf8))
                } catch {
                    throw AmbientAssistClientError.invalidResponse("Invalid stream event: \(error.localizedDescription)")
                }
                switch event.type {
                case "assistant_message_start":
                    continue
                case "assistant_message_delta":
                    guard let delta = event.delta else {
                        throw AmbientAssistClientError.invalidResponse("A stream delta had no text")
                    }
                    if !firstDeltaLogged {
                        firstDeltaLogged = true
                        NSLog(
                            "[metaflow] ambient.assist.first_delta request_id=%@ elapsed_ms=%.1f",
                            requestID,
                            Date().timeIntervalSince(started) * 1_000
                        )
                    }
                    await onDelta(delta)
                case "tool_activity":
                    guard let tool = event.tool else {
                        throw AmbientAssistClientError.invalidResponse("A tool activity event had no tool payload")
                    }
                    NSLog(
                        "[metaflow] ambient.assist.tool_activity request_id=%@ tool_call_id=%@ status=%@",
                        requestID,
                        tool.toolCallID,
                        tool.status ?? "unknown"
                    )
                    await onToolActivity(tool)
                case "assistant_message_done":
                    guard let completed = event.result else {
                        throw AmbientAssistClientError.invalidResponse("The completion event had no result")
                    }
                    result = completed
                case "assistant_message_error":
                    throw AmbientAssistClientError.rejected(
                        status: http.statusCode,
                        code: event.code,
                        message: event.error ?? "The assist stream failed"
                    )
                default:
                    throw AmbientAssistClientError.invalidResponse("Unsupported stream event: \(event.type)")
                }
            }
            guard let result else { throw AmbientAssistClientError.invalidResponse("The assist stream ended without completion") }
            NSLog(
                "[metaflow] ambient.assist.succeeded request_id=%@ elapsed_ms=%.1f",
                requestID,
                Date().timeIntervalSince(started) * 1_000
            )
            return result
        } catch {
            NSLog(
                "[metaflow] ambient.assist.failed request_id=%@ elapsed_ms=%.1f error=%@",
                requestID,
                Date().timeIntervalSince(started) * 1_000,
                error.localizedDescription
            )
            throw error
        }
    }

    func makeRequest(
        requestID: String,
        conversationID: String? = nil,
        prompt: String,
        source: AmbientAssistSource,
        transcript: String?,
        snapshot: AccessibilitySnapshot?,
        screenImage: AmbientScreenImage,
        agent: AgentBackendConfiguration = .defaultValue
    ) throws -> URLRequest {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
            throw AmbientAssistClientError.invalidEndpoint
        }
        components.path = "/ambient/v1/assist"
        components.queryItems = nil
        guard let url = components.url else { throw AmbientAssistClientError.invalidEndpoint }

        let context = AmbientAssistContext(snapshot: snapshot, transcript: transcript)
        let body = AmbientAssistRequest(
            requestID: requestID,
            conversationID: conversationID ?? self.conversationID,
            prompt: prompt,
            source: source,
            currentContext: context,
            screenImage: screenImage,
            agent: agent
        )
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }
}

enum AmbientAssistSource: String, Encodable {
    case typed
    case voice
}

struct AmbientAssistResult: Decodable {
    let requestID: String
    let conversationID: String
    let text: String

    enum CodingKeys: String, CodingKey {
        case requestID = "request_id"
        case conversationID = "conversation_id"
        case text
    }
}

struct AmbientToolActivityEvent: Decodable, Equatable {
    let toolCallID: String
    let title: String?
    let kind: String?
    let status: String?
    let toolName: String?

    enum CodingKeys: String, CodingKey {
        case toolCallID = "tool_call_id"
        case title
        case kind
        case status
        case toolName = "tool_name"
    }
}

private struct AmbientAssistRequest: Encodable {
    let requestID: String
    let conversationID: String
    let prompt: String
    let source: AmbientAssistSource
    let currentContext: AmbientAssistContext
    let screenImage: AmbientScreenImage
    let agent: AgentBackendConfiguration

    enum CodingKeys: String, CodingKey {
        case requestID = "request_id"
        case conversationID = "conversation_id"
        case prompt
        case source
        case currentContext = "current_context"
        case screenImage = "screen_image"
        case agent
    }
}

private struct AmbientAssistContext: Encodable {
    let voice: VoiceContext?
    let screen: ScreenContext?
    let app: AppContext?

    init(snapshot: AccessibilitySnapshot?, transcript: String?) {
        let normalizedTranscript = normalize(transcript ?? "")
        voice = normalizedTranscript.isEmpty ? nil : VoiceContext(
            transcript: normalizedTranscript,
            language: Locale.current.identifier
        )
        if let snapshot {
            let focused = bounded(snapshot.focusedValue, limit: 50_000)
            screen = ScreenContext(
                title: bounded(snapshot.windowTitle, limit: 2_000),
                app: snapshot.appName,
                text: focused,
                selectedText: bounded(snapshot.selectedText, limit: 50_000)
            )
            app = AppContext(
                name: snapshot.appName,
                bundleID: snapshot.bundleIdentifier,
                windowTitle: bounded(snapshot.windowTitle, limit: 2_000)
            )
        } else {
            screen = nil
            app = nil
        }
    }
}

private struct VoiceContext: Encodable {
    let transcript: String
    let language: String
}

private struct ScreenContext: Encodable {
    let title: String?
    let app: String
    let text: String?
    let selectedText: String?

    enum CodingKeys: String, CodingKey {
        case title
        case app
        case text
        case selectedText = "selected_text"
    }
}

private struct AppContext: Encodable {
    let name: String
    let bundleID: String
    let windowTitle: String?

    enum CodingKeys: String, CodingKey {
        case name
        case bundleID = "bundle_id"
        case windowTitle = "window_title"
    }
}

private struct AmbientAssistResponse: Decodable {
    let ok: Bool
    let result: AmbientAssistResult?
    let code: String?
    let error: String?
}

private struct AmbientAssistStreamEvent: Decodable {
    let type: String
    let delta: String?
    let result: AmbientAssistResult?
    let code: String?
    let error: String?
    let tool: AmbientToolActivityEvent?
}

enum AmbientAssistClientError: LocalizedError {
    case invalidEndpoint
    case missingHTTPResponse
    case rejected(status: Int, code: String?, message: String)
    case invalidResponse(String)

    var errorDescription: String? {
        switch self {
        case .invalidEndpoint:
            return "The configured Ambient endpoint is invalid."
        case .missingHTTPResponse:
            return "The Ambient daemon returned no HTTP response."
        case .rejected(let status, let code, let message):
            return "Ambient assist rejected (HTTP \(status), \(code ?? "unknown")): \(message)"
        case .invalidResponse(let message):
            return "Ambient assist returned an invalid response: \(message)"
        }
    }
}

private func bounded(_ value: String?, limit: Int) -> String? {
    let normalized = normalize(value ?? "")
    guard !normalized.isEmpty else { return nil }
    return String(normalized.prefix(limit))
}

private func collect(bytes: URLSession.AsyncBytes) async throws -> Data {
    var data = Data()
    for try await byte in bytes {
        data.append(byte)
        if data.count > 1_000_000 {
            throw AmbientAssistClientError.invalidResponse("The error response exceeded 1 MB")
        }
    }
    return data
}
