import AVFoundation
import Carbon.HIToolbox
import CryptoKit
import MarkdownUI
import SwiftUI
import XCTest
@testable import MetaflowMac

final class AccessibilitySmokeTests: XCTestCase {
    func testResidentOperationWireConstantsMatchCanonicalContract() {
        XCTAssertEqual(ResidentOperationWireContract.protocolName, "metaflow-operations-http")
        XCTAssertEqual(ResidentOperationWireContract.protocolVersion, 1)
        XCTAssertEqual(ResidentOperationWireContract.serverName, "ambient-daemon")
        XCTAssertEqual(ResidentOperationWireContract.serverVersion, "0.1.0")
        XCTAssertEqual(ResidentOperationWireContract.catalogVersion, 1)
        XCTAssertEqual(ResidentOperationWireContract.catalogFingerprint, "sha256:1c363c4ecb05e39def4e8aa7ae27957b0298d6c4405a1cc048de7bbdc767bcfc")
        XCTAssertEqual(ResidentOperationWireContract.authenticationSource, "METAFLOW_AUTH_TOKEN")
        XCTAssertEqual(ResidentOperationWireContract.authenticationRequired, true)
        XCTAssertEqual(ResidentOperationWireContract.authenticationScheme, "Bearer")
        XCTAssertEqual(ResidentOperationWireContract.challengeScheme, "HMAC-SHA256")
        XCTAssertEqual(ResidentOperationWireContract.operations.count, 20)
        XCTAssertEqual(ResidentOperationWireContract.operationsEndpoint, "/metaflow/v1/operations/")
        XCTAssertEqual(ResidentOperationWireContract.mcpEndpoint, "/mcp")
    }

    func testResidentOperationAccessRejectsRemoteAndCredentialBearingEndpoints() {
        let token = "test-operation-auth-token-32-bytes"
        XCTAssertThrowsError(try ResidentOperationAccessClient(endpoint: URL(string: "http://192.0.2.10:3111")!, token: token))
        XCTAssertThrowsError(try ResidentOperationAccessClient(endpoint: URL(string: "http://user:secret@127.0.0.1:3111")!, token: token))
        XCTAssertThrowsError(try ResidentOperationAccessClient(endpoint: URL(string: "http://127.0.0.1:3111/path")!, token: token))
    }

    func testResidentOperationDoctorIsCredentialFreeAndRejectsAnExactMimic() throws {
        let token = "test-operation-auth-token-32-bytes"
        let challenge = String(repeating: "a", count: 64)
        let client = try ResidentOperationAccessClient(endpoint: URL(string: "http://localhost:3111")!, token: token)
        let request = try client.makeDoctorRequest(challenge: challenge)
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(request.url?.host, "127.0.0.1")
        XCTAssertEqual(request.url?.path, "/metaflow/v1/doctor")

        let body: [String: Any] = [
            "ok": true,
            "protocol": ["name": ResidentOperationWireContract.protocolName, "version": ResidentOperationWireContract.protocolVersion],
            "server": ["name": ResidentOperationWireContract.serverName, "version": ResidentOperationWireContract.serverVersion, "origin": "http://127.0.0.1:3111"],
            "authentication": [
                "source": "METAFLOW_AUTH_TOKEN",
                "required": true,
                "scheme": "Bearer",
                "challenge_scheme": "HMAC-SHA256",
                "challenge": challenge,
                "proof": String(repeating: "0", count: 64)
            ],
            "catalog": [
                "version": ResidentOperationWireContract.catalogVersion,
                "fingerprint": ResidentOperationWireContract.catalogFingerprint,
                "operations": ResidentOperationWireContract.operations
            ],
            "endpoints": ["operations": ResidentOperationWireContract.operationsEndpoint, "mcp": ResidentOperationWireContract.mcpEndpoint]
        ]
        let data = try JSONSerialization.data(withJSONObject: body)
        let response = try XCTUnwrap(HTTPURLResponse(
            url: try XCTUnwrap(request.url),
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["x-metaflow-protocol-version": "1"]
        ))
        XCTAssertThrowsError(try client.validateDoctor(data: data, response: response, challenge: challenge)) { error in
            XCTAssertTrue(error.localizedDescription.contains("credential proof mismatch"))
        }
    }

    func testResidentClientFreshlyAuthorizesEveryMacAndAssistRoute() async throws {
        let token = "test-operation-auth-token-32-bytes"
        let endpoint = URL(string: "http://127.0.0.1:3111")!
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResidentAccessURLProtocol.self]
        let session = URLSession(configuration: configuration)
        var doctorRequests: [URLRequest] = []
        ResidentAccessURLProtocol.handler = { request in
            doctorRequests.append(request)
            let url = try XCTUnwrap(request.url)
            let challenge = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "challenge" })?.value)
            let body = residentDoctorBody(token: token, challenge: challenge, origin: "http://127.0.0.1:3111")
            let response = try XCTUnwrap(HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["x-metaflow-protocol-version": "1"]
            ))
            return (response, try JSONSerialization.data(withJSONObject: body))
        }
        defer { ResidentAccessURLProtocol.handler = nil }

        let client = try ResidentOperationAccessClient(endpoint: endpoint, token: token, session: session)
        let paths = [
            "/automation/v1/macos/voice-signals",
            "/automation/v1/macos/deliveries",
            "/automation/v1/macos/interactions",
            "/ambient/v1/assist",
            "/context/v1/views/view%3Aprivate?revision=1"
        ]
        for path in paths {
            let request = URLRequest(url: URL(string: path, relativeTo: endpoint)!)
            let authorized = try await client.authorize(request)
            XCTAssertEqual(authorized.value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")
            XCTAssertEqual(authorized.url?.host, "127.0.0.1")
        }
        XCTAssertEqual(doctorRequests.count, paths.count)
        XCTAssertTrue(doctorRequests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == nil })
        XCTAssertTrue(doctorRequests.allSatisfy { $0.url?.path == "/metaflow/v1/doctor" })
    }

    func testPermissionDeniedFailsExplicitly() {
        let result = evaluateAccessibilitySmoke(trusted: false, snapshot: nil, requireSelectedText: false)
        XCTAssertEqual(result.exitCode, 2)
        XCTAssertEqual(result.output["code"] as? String, "accessibility_permission_denied")
    }

    func testMissingFrontmostApplicationIsNotMisreportedAsPermissionDenied() {
        let result = evaluateAccessibilitySmoke(trusted: true, snapshot: nil, requireSelectedText: false)
        XCTAssertEqual(result.exitCode, 3)
        XCTAssertEqual(result.output["code"] as? String, "frontmost_application_unavailable")
    }

    func testStrictSelectedTextSmokeRejectsLoginWindow() {
        let result = evaluateAccessibilitySmoke(
            trusted: true,
            snapshot: snapshot(bundleIdentifier: "com.apple.loginwindow", selectedText: nil),
            requireSelectedText: true,
            capturedAt: "2026-07-26T12:00:00.000Z"
        )
        XCTAssertEqual(result.exitCode, 4)
        XCTAssertEqual(result.output["code"] as? String, "selected_text_unavailable")
        XCTAssertEqual(result.output["likely_screen_locked"] as? Bool, true)
    }

    func testStrictSelectedTextSmokeAcceptsNonEmptySelection() {
        let result = evaluateAccessibilitySmoke(
            trusted: true,
            snapshot: snapshot(bundleIdentifier: "com.apple.TextEdit", selectedText: "Metaflow exact live selection"),
            requireSelectedText: true,
            capturedAt: "2026-07-26T12:00:00.000Z"
        )
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(result.output["ok"] as? Bool, true)
        let accessibility = result.output["accessibility"] as? [String: Any]
        XCTAssertEqual(accessibility?["selected_text"] as? String, "Metaflow exact live selection")
    }

    func testPermissionStatusLabelsRemainClosedAndObservable() {
        XCTAssertEqual(microphoneAuthorizationLabel(.denied), "denied")
        XCTAssertEqual(microphoneAuthorizationLabel(.restricted), "restricted")
    }

    @MainActor
    func testReleaseBeforeDoubaoConnectFinishesAfterConnectionWithoutDroppingCallback() async {
        let transcriber = DelayedSpeechTranscriber(result: "豆包转写完成")
        let recognizer = PushToTalkSpeechRecognizer(makeTranscriber: { transcriber })
        let completed = expectation(description: "voice completion")
        var transcript: String?

        recognizer.start(onReady: {}, completion: { result in
            transcript = result.transcript
            completed.fulfill()
        })
        recognizer.stop()
        await transcriber.completeConnection()
        await fulfillment(of: [completed], timeout: 1)

        XCTAssertEqual(transcript, "豆包转写完成")
        XCTAssertEqual(transcriber.finishCount, 1)
    }

    func testAssistRequestContainsCurrentAccessibilityContext() throws {
        let client = AmbientAssistClient(endpoint: URL(string: "http://127.0.0.1:3112")!)
        let request = try client.makeRequest(
            requestID: "request:test",
            prompt: "总结当前内容",
            source: .voice,
            transcript: "总结当前内容",
            snapshot: snapshot(bundleIdentifier: "com.apple.TextEdit", selectedText: "Metaflow selected context"),
            screenImage: AmbientScreenImage(mimeType: "image/jpeg", data: Data("jpeg fixture".utf8))
        )
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any]
        )
        let context = try XCTUnwrap(object["current_context"] as? [String: Any])
        let screen = try XCTUnwrap(context["screen"] as? [String: Any])
        let voice = try XCTUnwrap(context["voice"] as? [String: Any])
        let screenImage = try XCTUnwrap(object["screen_image"] as? [String: Any])
        let agent = try XCTUnwrap(object["agent"] as? [String: Any])

        XCTAssertEqual(request.url?.path, "/ambient/v1/assist")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/x-ndjson")
        XCTAssertEqual(object["conversation_id"] as? String, client.conversationID)
        XCTAssertEqual(screen["selected_text"] as? String, "Metaflow selected context")
        XCTAssertEqual(voice["transcript"] as? String, "总结当前内容")
        XCTAssertEqual(screenImage["mime_type"] as? String, "image/jpeg")
        XCTAssertEqual(screenImage["data"] as? String, Data("jpeg fixture".utf8).base64EncodedString())
        XCTAssertEqual(agent["harness"] as? String, "claude_code_acp")
        XCTAssertEqual(agent["provider"] as? String, "xem-gpt")
        XCTAssertEqual(agent["model"] as? String, "gpt-5.6-terra")
    }

    func testAssistRequestCanTargetAnExplicitConversation() throws {
        let client = AmbientAssistClient(endpoint: URL(string: "http://127.0.0.1:3112")!)
        let request = try client.makeRequest(
            requestID: "request:second",
            conversationID: "metaflow-notch-second",
            prompt: "Continue the second conversation",
            source: .typed,
            transcript: nil,
            snapshot: nil,
            screenImage: AmbientScreenImage(mimeType: "image/jpeg", data: Data("jpeg fixture".utf8))
        )
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any]
        )

        XCTAssertEqual(object["conversation_id"] as? String, "metaflow-notch-second")
    }

    @MainActor
    func testBackgroundConversationKeepsStreamingAfterSwitching() async throws {
        let model = MetaflowNotchModel(streamRevealDelayNanoseconds: 1_000_000)
        let firstID = model.selectedConversationID
        model.submitText("Research the first topic")

        let secondID = model.newConversation()
        model.submitText("Work on the second topic")
        XCTAssertEqual(model.selectedConversationID, secondID)
        XCTAssertTrue(model.isSending)

        model.appendResponseDelta("First conversation result", conversationID: firstID)
        try await Task.sleep(nanoseconds: 10_000_000)

        XCTAssertEqual(model.selectedConversationID, secondID)
        XCTAssertEqual(model.messages.map(\.text), ["Work on the second topic"])
        XCTAssertEqual(
            model.conversation(withID: firstID).messages.map(\.text),
            ["Research the first topic", "First conversation result"]
        )

        model.dock()
        model.complete(text: "First conversation result", conversationID: firstID)
        XCTAssertEqual(model.presentation, .docked)
        XCTAssertEqual(model.selectedConversationID, secondID)
        XCTAssertEqual(model.conversation(withID: firstID).phase, .done)
    }

    @MainActor
    func testConversationHistoryRestoresTheMostRecentlyUpdatedConversation() {
        let suiteName = "MetaflowMacTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = MetaflowConversationStore(defaults: defaults, key: "conversation-test")

        let firstModel = MetaflowNotchModel(conversationStore: store)
        let firstID = firstModel.selectedConversationID
        firstModel.submitText("First saved conversation")
        firstModel.complete(text: "First answer", conversationID: firstID)
        let secondID = firstModel.newConversation()
        firstModel.submitText("Newest saved conversation")
        firstModel.complete(text: "Newest answer", conversationID: secondID)

        let restored = MetaflowNotchModel(conversationStore: store)
        XCTAssertEqual(restored.conversations.count, 2)
        XCTAssertEqual(restored.selectedConversationID, secondID)
        XCTAssertEqual(restored.selectedConversation.title, "Newest saved conversation")
        XCTAssertEqual(restored.messages.map(\.text), ["Newest saved conversation", "Newest answer"])
    }

    @MainActor
    func testConversationNavigationRequestsTheSelectedConversationHeight() {
        let model = MetaflowNotchModel()
        let longConversationID = model.selectedConversationID
        model.submitText("Explain the complete project state")
        model.complete(text: String(repeating: "Detailed project context. ", count: 80))
        let longHeight = model.expandedHeight

        var requestedHeights: [CGFloat] = []
        model.onContentChange = { [unowned model] _ in requestedHeights.append(model.expandedHeight) }

        let shortConversationID = model.newConversation()
        let shortHeight = model.expandedHeight
        model.selectConversation(longConversationID)
        model.selectConversation(shortConversationID)

        XCTAssertGreaterThan(longHeight, shortHeight)
        XCTAssertEqual(requestedHeights, [shortHeight, longHeight, shortHeight])
        XCTAssertEqual(model.selectedConversationID, shortConversationID)
    }

    @MainActor
    func testInlineConversationPickerOwnsItsExpandedHeightAndClosesOnSelection() {
        let model = MetaflowNotchModel()
        let firstID = model.selectedConversationID
        let secondID = model.newConversation()
        XCTAssertNotEqual(firstID, secondID)

        model.toggleConversationPicker()
        XCTAssertTrue(model.isConversationPickerPresented)
        XCTAssertEqual(model.expandedHeight, 466)

        model.selectConversation(firstID)
        XCTAssertFalse(model.isConversationPickerPresented)
        XCTAssertEqual(model.selectedConversationID, firstID)
    }

    @MainActor
    func testRapidConversationSwitchingPreservesEveryMessage() {
        let model = MetaflowNotchModel()
        let firstID = model.selectedConversationID
        model.submitText("First prompt")
        model.complete(text: String(repeating: "First answer paragraph. ", count: 160))

        let secondID = model.newConversation()
        model.submitText("Second prompt")
        model.complete(text: "Second answer")

        let expected = Dictionary(uniqueKeysWithValues: model.conversations.map { conversation in
            (conversation.id, conversation.messages)
        })
        for index in 0..<200 {
            model.selectConversation(index.isMultiple(of: 2) ? firstID : secondID)
        }

        XCTAssertEqual(model.conversations.count, expected.count)
        for conversation in model.conversations {
            XCTAssertEqual(conversation.messages, expected[conversation.id])
        }
    }

    @MainActor
    func testCurrentTurnProjectionKeepsEarlierHistoryOutOfTheSwitchingPath() {
        let model = MetaflowNotchModel()
        model.submitText("First prompt")
        model.complete(text: "First answer")
        model.submitText("Second prompt")
        model.complete(text: "Second answer")
        model.submitText("Current prompt")
        model.complete(text: "Current answer")

        XCTAssertEqual(model.messages.count, 6)
        XCTAssertEqual(model.earlierMessageCount, 4)
        XCTAssertEqual(model.currentTurnMessages.map(\.text), ["Current prompt", "Current answer"])
    }

    func testMessageMarkdownCacheTracksTextAndRoundTripsThroughPersistence() throws {
        var message = MetaflowNotchMessage(role: .assistant, text: "# First", isError: false)
        message.text = "# Second\n\n- item"

        let restored = try JSONDecoder().decode(
            MetaflowNotchMessage.self,
            from: JSONEncoder().encode(message)
        )

        XCTAssertEqual(restored, message)
        XCTAssertEqual(restored.markdownContent, MarkdownContent(message.text))
    }

    @MainActor
    func testConversationStoreMigratesPreferencesIntoStableAtomicFile() throws {
        let suite = "metaflow-store-migration-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("metaflow-store-migration-\(UUID().uuidString)", isDirectory: true)
        let fileURL = directory.appendingPathComponent("conversations-v1.json")
        defer {
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: directory)
        }
        let snapshot = MetaflowConversationSnapshot(
            id: "conversation-1",
            title: "Persisted",
            createdAt: Date(timeIntervalSince1970: 1),
            updatedAt: Date(timeIntervalSince1970: 2),
            messages: [MetaflowNotchMessage(role: .user, text: "hello", isError: false)],
            resultTitle: "Result",
            resultText: "hello"
        )
        defaults.set(try JSONEncoder().encode([snapshot]), forKey: "metaflow.notch.conversations.v1")
        let store = MetaflowConversationStore(defaults: defaults, fileURL: fileURL)

        XCTAssertEqual(try store.load(), [snapshot])
        XCTAssertTrue(FileManager.default.fileExists(atPath: fileURL.path))
        defaults.removeObject(forKey: "metaflow.notch.conversations.v1")
        XCTAssertEqual(try store.load(), [snapshot])
    }

    @MainActor
    func testOpenConversationStreamsWithoutChangingPresentation() async throws {
        let model = MetaflowNotchModel(streamRevealDelayNanoseconds: 1_000_000)
        model.open()
        model.beginWorking()
        XCTAssertEqual(model.presentation, .expanded)
        XCTAssertTrue(model.showsActivity)
        model.appendResponseDelta("**Meta")
        try await Task.sleep(nanoseconds: 10_000_000)
        XCTAssertEqual(model.presentation, .expanded)
        XCTAssertFalse(model.showsActivity)
        model.appendResponseDelta("flow**\n- ready")
        model.complete(title: "Metaflow", text: "**Metaflow**\n- ready")

        XCTAssertEqual(model.messages.count, 1)
        XCTAssertEqual(model.messages.first?.role, .assistant)
        XCTAssertEqual(model.messages.first?.text, "**Metaflow**\n- ready")
        XCTAssertEqual(model.phase, .done)
        XCTAssertFalse(model.isSending)
    }

    @MainActor
    func testStreamingMarkdownBatchesIntermediateRendersAndFlushesFinalText() async throws {
        let model = MetaflowNotchModel(
            streamRevealDelayNanoseconds: 1_000_000,
            streamRenderIntervalNanoseconds: 50_000_000
        )
        model.open()
        model.beginWorking()
        model.appendResponseDelta("First")
        try await Task.sleep(nanoseconds: 10_000_000)
        XCTAssertEqual(model.messages.first?.text, "First")

        model.appendResponseDelta(" second")
        model.appendResponseDelta(" third")
        XCTAssertEqual(model.messages.first?.text, "First")

        try await Task.sleep(nanoseconds: 70_000_000)
        XCTAssertEqual(model.messages.first?.text, "First second third")

        model.appendResponseDelta(" final")
        model.complete(text: "First second third final")
        XCTAssertEqual(model.messages.first?.text, "First second third final")
    }

    @MainActor
    func testVoiceLifecycleStaysDockedUntilTheAnswerCompletes() async throws {
        let model = MetaflowNotchModel(streamRevealDelayNanoseconds: 1_000_000)
        model.open()

        model.beginPreparingVoice(context: nil)
        XCTAssertEqual(model.presentation, .docked)
        model.beginListening(context: nil)
        XCTAssertEqual(model.presentation, .docked)
        model.beginTranscribing()
        XCTAssertEqual(model.presentation, .docked)
        model.beginWorking()
        XCTAssertEqual(model.presentation, .docked)

        model.appendResponseDelta("Ready")
        try await Task.sleep(nanoseconds: 10_000_000)
        XCTAssertEqual(model.presentation, .docked)

        model.complete(text: "Ready")
        XCTAssertEqual(model.presentation, .expanded)
    }

    @MainActor
    func testToolActivitySuppressesPreludeAndShowsOnlyTheFinalAnswer() {
        let model = MetaflowNotchModel(streamRevealDelayNanoseconds: 1_000_000_000)
        model.submitText("Search for this")
        model.appendResponseDelta("I will search for that.")
        model.recordToolActivity(AmbientToolActivityEvent(
            toolCallID: "tool:web",
            title: "Search the web",
            kind: "search",
            status: "pending",
            toolName: "WebSearch"
        ))

        XCTAssertEqual(model.messages.count, 1)
        XCTAssertEqual(model.messages.first?.role, .user)
        XCTAssertEqual(model.presentation, .docked)
        XCTAssertEqual(model.toolActivities.count, 1)

        model.recordToolActivity(AmbientToolActivityEvent(
            toolCallID: "tool:web",
            title: nil,
            kind: nil,
            status: "completed",
            toolName: nil
        ))
        model.appendResponseDelta("Here is the final answer.")
        XCTAssertEqual(model.toolActivities.count, 1)
        XCTAssertEqual(model.toolActivities.first?.status, "completed")
        XCTAssertEqual(model.messages.count, 1)

        model.complete(text: "Here is the final answer.")
        XCTAssertEqual(model.presentation, .expanded)
        XCTAssertEqual(model.messages.count, 2)
        XCTAssertEqual(model.messages.last?.role, .assistant)
        XCTAssertEqual(model.messages.last?.text, "Here is the final answer.")
    }

    @MainActor
    func testManualDockIsRespectedUntilTheActiveTurnCompletes() async throws {
        let model = MetaflowNotchModel(streamRevealDelayNanoseconds: 1_000_000)
        model.open()
        model.submitText("Research this")
        model.appendResponseDelta("Starting research.")
        try await Task.sleep(nanoseconds: 10_000_000)
        XCTAssertEqual(model.presentation, .expanded)

        model.dock()
        model.recordToolActivity(AmbientToolActivityEvent(
            toolCallID: "tool:research",
            title: "Search sources",
            kind: "search",
            status: "running",
            toolName: "WebSearch"
        ))
        model.appendResponseDelta("Research completed.")
        XCTAssertEqual(model.presentation, .docked)

        model.complete(text: "Research completed.")
        XCTAssertEqual(model.presentation, .expanded)
    }

    func testDefaultVoiceShortcutIsHoldRightOption() {
        let shortcut = VoiceShortcutConfiguration.defaultValue
        XCTAssertEqual(shortcut.mode, .rightOptionHold)
        XCTAssertEqual(shortcut.keyCode, UInt32(kVK_RightOption))
        XCTAssertEqual(shortcut.displayName, "Hold Right Option")
        XCTAssertEqual(VoiceShortcutConfiguration.optionSpace.displayName, "Option+Space")
    }

    func testDefaultAgentBackendUsesClaudeCodeACP() {
        let backend = AgentBackendConfiguration.defaultValue
        XCTAssertEqual(backend.harness, .claudeCodeACP)
        XCTAssertEqual(backend.provider, "xem-gpt")
        XCTAssertEqual(backend.model, "gpt-5.6-terra")
        XCTAssertEqual(backend.displayName, "Claude Code ACP")
    }

    @MainActor
    func testMarkdownUsesBlockRendererForStructuredContent() {
        let markdown = """
        # 标题

        第一段。

        - 第一项
          - 嵌套项

        `inline` and [link](https://example.com)
        """
        let view = MetaflowMarkdownText(markdown)
            .frame(width: 430)
            .padding(24)
            .background(Color.black)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2

        let image = renderer.nsImage
        XCTAssertNotNil(image)
        XCTAssertGreaterThan(image?.size.height ?? 0, 120)
    }

    func testTypedPromptCanCreateAStrictPositiveShortcutInterval() {
        let pressedAt = Date(timeIntervalSince1970: 1_785_046_400)
        let releasedAt = pressedAt.addingTimeInterval(0.001)
        let pressedTimestamp = isoTimestamp(pressedAt)
        let releasedTimestamp = isoTimestamp(releasedAt)

        XCTAssertLessThan(pressedTimestamp, releasedTimestamp)
        XCTAssertEqual(
            Self.parseIso(releasedTimestamp).timeIntervalSince(Self.parseIso(pressedTimestamp)),
            0.001,
            accuracy: 0.000_1
        )
    }

    func testExactViewURLIsNotDoubleEncoded() {
        let url = metaflowExactViewURL(
            base: URL(string: "http://127.0.0.1:3112")!,
            viewID: "view:failure:run:automation:1",
            revision: 2
        )
        XCTAssertNotNil(url)
        XCTAssertFalse(url!.absoluteString.contains("%25"))
        XCTAssertEqual(url!.query, "revision=2")
    }

    private static func parseIso(_ value: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)!
    }

    private func snapshot(bundleIdentifier: String, selectedText: String?) -> AccessibilitySnapshot {
        AccessibilitySnapshot(
            appName: bundleIdentifier == "com.apple.TextEdit" ? "TextEdit" : "loginwindow",
            bundleIdentifier: bundleIdentifier,
            processIdentifier: 42,
            windowTitle: "Smoke",
            role: "AXTextArea",
            subrole: nil,
            focusedValue: nil,
            selectedText: selectedText,
            description: nil,
            placeholder: nil
        )
    }
}

private final class ResidentAccessURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private func residentDoctorBody(token: String, challenge: String, origin: String) -> [String: Any] {
    let message = "metaflow-doctor-v1:\(challenge):\(origin):\(ResidentOperationWireContract.catalogFingerprint)"
    let signature = HMAC<SHA256>.authenticationCode(
        for: Data(message.utf8),
        using: SymmetricKey(data: Data(token.utf8))
    )
    let proof = Data(signature).map { String(format: "%02x", $0) }.joined()
    return [
        "ok": true,
        "protocol": ["name": ResidentOperationWireContract.protocolName, "version": ResidentOperationWireContract.protocolVersion],
        "server": ["name": ResidentOperationWireContract.serverName, "version": ResidentOperationWireContract.serverVersion, "origin": origin],
        "authentication": [
            "source": ResidentOperationWireContract.authenticationSource,
            "required": true,
            "scheme": ResidentOperationWireContract.authenticationScheme,
            "challenge_scheme": ResidentOperationWireContract.challengeScheme,
            "challenge": challenge,
            "proof": proof
        ],
        "catalog": [
            "version": ResidentOperationWireContract.catalogVersion,
            "fingerprint": ResidentOperationWireContract.catalogFingerprint,
            "operations": ResidentOperationWireContract.operations
        ],
        "endpoints": [
            "operations": ResidentOperationWireContract.operationsEndpoint,
            "mcp": ResidentOperationWireContract.mcpEndpoint
        ]
    ]
}

@MainActor
private final class DelayedSpeechTranscriber: SpeechTranscriber {
    private let result: String
    private var startContinuation: CheckedContinuation<Void, Never>?
    private(set) var finishCount = 0

    init(result: String) {
        self.result = result
    }

    func start() async throws {
        await withCheckedContinuation { continuation in
            startContinuation = continuation
        }
    }

    func completeConnection() async {
        while startContinuation == nil {
            await Task.yield()
        }
        startContinuation?.resume()
        startContinuation = nil
    }

    func finish() async throws -> String {
        finishCount += 1
        return result
    }

    func cancel() {
        startContinuation?.resume()
        startContinuation = nil
    }
}
