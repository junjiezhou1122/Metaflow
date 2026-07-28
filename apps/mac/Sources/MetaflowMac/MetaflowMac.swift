import AppKit
import ApplicationServices
import AVFoundation
import Carbon.HIToolbox
import Darwin
import Foundation

@MainActor
final class MetaflowMac: NSObject, NSApplicationDelegate {
    private let endpoint = URL(string: ProcessInfo.processInfo.environment["INFO_CONTEXT_INGEST_ENDPOINT"] ?? "http://localhost:3111/context/ingest")!
    private let ambientEndpoint = URL(string: ProcessInfo.processInfo.environment["METAFLOW_AMBIENT_ENDPOINT"] ?? "http://localhost:3112")!
    private let operationAuthToken = LocalEnvironment.value("METAFLOW_AUTH_TOKEN")
    private lazy var assistClient = AmbientAssistClient(endpoint: ambientEndpoint, token: operationAuthToken)
    private let pollSeconds = TimeInterval(ProcessInfo.processInfo.environment["METAFLOW_MAC_POLL_SECONDS"].flatMap(Double.init) ?? 1.2)
    private let minWritingCharacters = Int(ProcessInfo.processInfo.environment["METAFLOW_MAC_MIN_WRITING_CHARS"].flatMap(Int.init) ?? 24)
    private let maxWritingCharacters = Int(ProcessInfo.processInfo.environment["METAFLOW_MAC_MAX_WRITING_CHARS"].flatMap(Int.init) ?? 4_000)
    private let allowExternalLlm = ProcessInfo.processInfo.environment["METAFLOW_MAC_ALLOW_EXTERNAL_LLM"] == "1"
    private let startedAt = isoNow()

    private var statusItem: NSStatusItem!
    private var panel: NSWindow!
    private var statusLabel: NSTextField!
    private var detailLabel: NSTextField!
    private var suggestionTitleLabel: NSTextField!
    private var suggestionBodyLabel: NSTextField!
    private var copyButton: NSButton!
    private var dismissButton: NSButton!
    private var timer: Timer?
    private var ambientTimer: Timer?
    private var running = true
    private var lastFocusKey = ""
    private var lastWritingText = ""
    private var lastWritingSentAt = Date.distantPast
    private var lastViewPollAt = Date.distantPast
    private var latestSuggestion: WritingSuggestion?
    private var latestAmbientCard: AmbientDeliveryCard?
    private var ambientPollInFlight = false
    private var lastAmbientPollFailure = ""
    private var globalPushToTalk: GlobalPushToTalk?
    private let voiceShortcutStore = VoiceShortcutStore()
    private var voiceShortcut = VoiceShortcutConfiguration.defaultValue
    private let agentBackendStore = AgentBackendStore()
    private var agentBackend = AgentBackendConfiguration.defaultValue
    private let voiceShortcutSettings = VoiceShortcutSettingsController()
    private let speechRecognizer = PushToTalkSpeechRecognizer()
    private let screenCapture = AmbientScreenCaptureService()
    private var activeVoiceSession: ActiveVoiceSession?
    private var lastExternalSnapshot: AccessibilitySnapshot?
    private var frozenNotchSnapshot: AccessibilitySnapshot?
    private let notchModel = MetaflowNotchModel(conversationStore: .live)
    private var notchPanel: MetaflowNotchPanelController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildStatusItem()
        configureNotch()
        voiceShortcut = voiceShortcutStore.load()
        agentBackend = agentBackendStore.load()
        notchModel.shortcutLabel = voiceShortcut.displayName
        refreshAccessibilityStatus(prompt: false)
        registerPushToTalk()
        notchPanel.show()
    }

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "M"
        statusItem.button?.target = self
        statusItem.button?.action = #selector(showNotch)

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Open Metaflow", action: #selector(showNotch), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Request Accessibility Permission", action: #selector(requestAccessibilityPermission), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Request Microphone Permission", action: #selector(requestVoicePermissions), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Settings...", action: #selector(showVoiceShortcutSettings), keyEquivalent: ","))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
        statusItem.menu = menu
    }

    private func configureNotch() {
        notchModel.onWillOpen = { [weak self] in self?.freezeNotchAccessibilityContext() }
        notchModel.onSubmitText = { [weak self] conversationID, command in
            self?.submitTypedCommand(command, conversationID: conversationID)
        }
        notchModel.onStartVoice = { [weak self] in self?.beginPushToTalk() }
        notchModel.onStopVoice = { [weak self] in self?.endPushToTalk() }
        notchModel.onCopy = { [weak self] in self?.copyNotchResult() }
        notchModel.onRequestPermissions = { [weak self] in self?.requestVoicePermissions() }
        notchPanel = MetaflowNotchPanelController(model: notchModel)
    }

    private func buildPanel() {
        panel = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 320),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        panel.title = "Metaflow"
        panel.level = .normal
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.titleVisibility = .visible
        panel.titlebarAppearsTransparent = false
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = NSColor.windowBackgroundColor

        let root = NSStackView()
        root.orientation = .vertical
        root.spacing = 10
        root.edgeInsets = NSEdgeInsets(top: 18, left: 18, bottom: 16, right: 18)
        root.translatesAutoresizingMaskIntoConstraints = false

        let title = NSTextField(labelWithString: "metaflow mac companion")
        title.font = .systemFont(ofSize: 15, weight: .semibold)

        statusLabel = NSTextField(labelWithString: "Starting...")
        statusLabel.font = .systemFont(ofSize: 13, weight: .medium)

        detailLabel = NSTextField(wrappingLabelWithString: "Watching focused macOS controls and sending local Observations to Metaflow.")
        detailLabel.font = .systemFont(ofSize: 12)
        detailLabel.textColor = .secondaryLabelColor

        let separator = NSBox()
        separator.boxType = .separator

        suggestionTitleLabel = NSTextField(labelWithString: "AI writing suggestion")
        suggestionTitleLabel.font = .systemFont(ofSize: 13, weight: .semibold)

        suggestionBodyLabel = NSTextField(wrappingLabelWithString: "Waiting for current-session writing. Type in a local app after enabling Accessibility permission.")
        suggestionBodyLabel.font = .systemFont(ofSize: 13)
        suggestionBodyLabel.textColor = .labelColor
        suggestionBodyLabel.maximumNumberOfLines = 6

        let actions = NSStackView()
        actions.orientation = .horizontal
        actions.spacing = 8

        let permission = NSButton(title: "Permission", target: self, action: #selector(requestAccessibilityPermission))
        let pause = NSButton(title: "Pause", target: self, action: #selector(toggleCapture))
        actions.addArrangedSubview(permission)
        actions.addArrangedSubview(pause)

        let suggestionActions = NSStackView()
        suggestionActions.orientation = .horizontal
        suggestionActions.spacing = 8
        copyButton = NSButton(title: "Copy", target: self, action: #selector(copySuggestion))
        dismissButton = NSButton(title: "Dismiss", target: self, action: #selector(dismissSuggestion))
        copyButton.isEnabled = false
        dismissButton.isEnabled = false
        suggestionActions.addArrangedSubview(copyButton)
        suggestionActions.addArrangedSubview(dismissButton)

        root.addArrangedSubview(title)
        root.addArrangedSubview(statusLabel)
        root.addArrangedSubview(detailLabel)
        root.addArrangedSubview(actions)
        root.addArrangedSubview(separator)
        root.addArrangedSubview(suggestionTitleLabel)
        root.addArrangedSubview(suggestionBodyLabel)
        root.addArrangedSubview(suggestionActions)

        let content = NSView()
        content.addSubview(root)
        panel.contentView = content
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            root.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            root.topAnchor.constraint(equalTo: content.topAnchor),
            root.bottomAnchor.constraint(equalTo: content.bottomAnchor)
        ])
        positionPanel()
    }

    private func startPolling() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: pollSeconds, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.tick()
            }
        }
        RunLoop.main.add(timer!, forMode: .common)
    }

    private func startAmbientPolling() {
        ambientTimer?.invalidate()
        ambientTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pollAmbientDeliveries() }
        }
        RunLoop.main.add(ambientTimer!, forMode: .common)
    }

    private func tick() {
        pollFocusedContext()
        if latestSuggestion == nil {
            pollWritingViewsIfDue()
        }
    }

    private func pollFocusedContext() {
        guard running else { return }
        guard accessibilityTrusted(prompt: false) else {
            refreshAccessibilityStatus(prompt: false)
            return
        }
        guard let app = NSWorkspace.shared.frontmostApplication else { return }

        let snapshot = AccessibilitySnapshot.capture(app: app)
        if app.bundleIdentifier != Bundle.main.bundleIdentifier {
            lastExternalSnapshot = snapshot
        }
        if snapshot.focusKey != lastFocusKey {
            lastFocusKey = snapshot.focusKey
            postFocusChanged(snapshot)
        }

        guard let text = snapshot.bestEditableText else {
            updateStatus("Watching \(snapshot.appName)", detail: snapshot.roleDescription)
            return
        }
        let normalized = normalize(text)
        guard shouldSendWritingText(normalized, snapshot: snapshot) else {
            updateStatus("Watching \(snapshot.appName)", detail: snapshot.roleDescription)
            return
        }
        lastWritingText = normalized
        lastWritingSentAt = Date()
        postEditorTextChanged(snapshot, text: normalized)
        updateStatus("Writing captured in \(snapshot.appName)", detail: snapshot.roleDescription)
    }

    private func shouldSendWritingText(_ text: String, snapshot: AccessibilitySnapshot) -> Bool {
        guard text.count >= minWritingCharacters && text.count <= maxWritingCharacters else { return false }
        guard text != lastWritingText else { return false }
        guard Date().timeIntervalSince(lastWritingSentAt) >= 2.5 else { return false }
        guard !snapshot.isSensitive else { return false }
        return true
    }

    private func postFocusChanged(_ snapshot: AccessibilitySnapshot) {
        let record = ContextRecord(
            schema: Schema(name: "observation.local_app.focus_changed", version: 1),
            source: Source(type: "local_app", connector: "metaflow-mac"),
            scope: Scope(app: snapshot.bundleIdentifier, domain: nil),
            time: RecordTime(observed_at: isoNow(), captured_at: isoNow()),
            content: Content(title: snapshot.windowTitle ?? snapshot.appName, url: nil, text: snapshot.focusSummary),
            acquisition: Acquisition(mode: "passive", actor: "user", reason: "macOS focused accessibility element changed"),
            signal: Signal(importance: 0.32, confidence: 0.72, status: "inbox"),
            privacy: Privacy(level: "private", retention: "local", allow_external_llm: allowExternalLlm),
            payload: snapshot.payload(kind: "focus_changed")
        )
        post(record, process: false)
    }

    private func postEditorTextChanged(_ snapshot: AccessibilitySnapshot, text: String) {
        var payload = snapshot.payload(kind: "editor_text_changed")
        payload["text"] = .string(String(text.prefix(maxWritingCharacters)))
        payload["text_length"] = .number(Double(text.count))
        payload["writing_surface"] = .string("mac_accessibility")

        let record = ContextRecord(
            schema: Schema(name: "observation.editor.text_changed", version: 1),
            source: Source(type: "local_app", connector: "metaflow-mac"),
            scope: Scope(app: snapshot.bundleIdentifier, domain: nil),
            time: RecordTime(observed_at: isoNow(), captured_at: isoNow()),
            content: Content(title: snapshot.windowTitle ?? snapshot.appName, url: nil, text: String(text.prefix(maxWritingCharacters))),
            acquisition: Acquisition(mode: "passive", actor: "user", reason: "macOS focused editor text changed"),
            signal: Signal(importance: 0.74, confidence: 0.7, status: "inbox"),
            privacy: Privacy(level: "private", retention: "local", allow_external_llm: allowExternalLlm),
            payload: payload
        )
        post(record, process: true)
    }

    private func post(_ record: ContextRecord, process: Bool) {
        var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
        if process {
            components.queryItems = [
                URLQueryItem(name: "process", value: "true"),
                URLQueryItem(name: "cascade_views", value: "true")
            ]
        }
        guard let url = components.url else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder.contextEncoder.encode(record)

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            Task { @MainActor in
                if let error {
                    self?.updateStatus("Metaflow backend offline", detail: error.localizedDescription)
                    return
                }
                if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                    self?.updateStatus("Metaflow compatibility ingest rejected", detail: "HTTP \(http.statusCode)")
                    return
                }
                if process {
                    if let data, let viewIds = IngestResponse.writingViewIds(from: data), !viewIds.isEmpty {
                        self?.pollWritingViews(ids: viewIds)
                    } else {
                        self?.pollWritingViews(force: true)
                    }
                }
            }
        }.resume()
    }

    private func pollWritingViewsIfDue() {
        guard Date().timeIntervalSince(lastViewPollAt) >= 3 else { return }
        pollWritingViews(force: false)
    }

    private func pollWritingViews(force: Bool) {
        if !force && Date().timeIntervalSince(lastViewPollAt) < 3 { return }
        lastViewPollAt = Date()
        guard let url = contextViewsURL() else { return }
        URLSession.shared.dataTask(with: URLRequest(url: url)) { [weak self] data, response, error in
            Task { @MainActor in
                if let error {
                    self?.suggestionBodyLabel?.stringValue = "Could not load suggestions: \(error.localizedDescription)"
                    return
                }
                if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                    self?.suggestionBodyLabel?.stringValue = "Could not load suggestions: HTTP \(http.statusCode)"
                    return
                }
                guard let data, let suggestion = WritingSuggestion.latest(from: data) else { return }
                self?.showSuggestion(suggestion)
            }
        }.resume()
    }

    private func pollWritingViews(ids: [String]) {
        let orderedIds = ids.sorted { lhs, rhs in
            if lhs.contains(":inline") && !rhs.contains(":inline") { return true }
            if !lhs.contains(":inline") && rhs.contains(":inline") { return false }
            return lhs < rhs
        }
        let urls = orderedIds.compactMap(contextViewURL)
        guard !urls.isEmpty else { return }
        let suggestions = WritingSuggestionAccumulator()
        let group = DispatchGroup()
        for url in urls {
            group.enter()
            URLSession.shared.dataTask(with: URLRequest(url: url)) { data, _, _ in
                defer { group.leave() }
                if let data, let suggestion = WritingSuggestion.single(from: data) {
                    suggestions.insert(suggestion)
                }
            }.resume()
        }
        group.notify(queue: .main) { [weak self] in
            let suggestion = suggestions.first(in: orderedIds)
            guard let suggestion else { return }
            Task { @MainActor in
                self?.showSuggestion(suggestion)
            }
        }
    }

    private func contextViewsURL() -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/context/views"
        components.queryItems = [
            URLQueryItem(name: "limit", value: "8"),
            URLQueryItem(name: "view_types", value: "draft.writing_continuation,advice.writing_assist"),
            URLQueryItem(name: "active_only", value: "true"),
            URLQueryItem(name: "updated_after", value: startedAt),
        ]
        return components.url
    }

    private func contextViewURL(id: String) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/context/views/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)"
        components.queryItems = nil
        return components.url
    }

    private func feedbackURL() -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/feedback"
        components.queryItems = [URLQueryItem(name: "process", value: "true")]
        return components.url
    }

    private func showSuggestion(_ suggestion: WritingSuggestion) {
        latestSuggestion = suggestion
        suggestionTitleLabel.stringValue = suggestion.title
        suggestionBodyLabel.stringValue = suggestion.text
        copyButton.isEnabled = true
        dismissButton.isEnabled = true
        notchModel.complete(title: suggestion.title, text: suggestion.text)
    }

    private func registerPushToTalk() {
        globalPushToTalk?.stop()
        let monitor = GlobalPushToTalk(
            configuration: voiceShortcut,
            onPress: { [weak self] in self?.beginPushToTalk() },
            onRelease: { [weak self] in self?.endPushToTalk() }
        )
        do {
            try monitor.start()
            globalPushToTalk = monitor
            notchModel.shortcutLabel = voiceShortcut.displayName
            updateStatus("Voice ready", detail: voiceShortcut.displayName)
        } catch {
            globalPushToTalk = nil
            updateStatus("Global shortcut unavailable", detail: error.localizedDescription)
        }
    }

    private func beginPushToTalk() {
        guard running, activeVoiceSession == nil else { return }
        let conversationID = notchModel.prepareConversationForVoice()
        let (trusted, snapshot) = currentAssistAccessibilityContext()
        let screenImage = startScreenCapture()
        let session = ActiveVoiceSession(
            id: UUID().uuidString,
            eventID: UUID().uuidString,
            conversationID: conversationID,
            pressedAt: isoNow(),
            snapshot: snapshot,
            accessibilityTrusted: trusted,
            screenImage: screenImage
        )
        activeVoiceSession = session
        notchModel.beginPreparingVoice(
            context: snapshot.map { "Context frozen from \($0.appName)" },
            conversationID: conversationID
        )
        speechRecognizer.start(
            onReady: { [weak self] in
                guard let self, self.activeVoiceSession?.id == session.id else { return }
                let action = self.voiceShortcut.mode == .rightOptionHold
                    ? "Release Right Option to ask."
                    : "Release \(self.voiceShortcut.displayName) to ask."
                let detail = snapshot.map { "Context frozen from \($0.appName). \(action)" } ?? action
                self.notchModel.beginListening(context: detail, conversationID: conversationID)
                self.updateStatus("Listening...", detail: detail)
            },
            completion: { [weak self] result in
                guard let self else { return }
                if self.activeVoiceSession?.id == session.id { self.activeVoiceSession = nil }
                self.submitVoiceSession(session, result: result)
            }
        )
    }

    private func endPushToTalk() {
        guard let session = activeVoiceSession else { return }
        activeVoiceSession = nil
        notchModel.beginTranscribing(conversationID: session.conversationID)
        updateStatus("Recognizing...", detail: "Doubao is finalizing the utterance.")
        speechRecognizer.stop()
    }

    private func submitVoiceSession(_ session: ActiveVoiceSession, result: PushToTalkSpeechRecognizer.Result) {
        let releasedAt = result.endedAt
        let speech: [String: Any]
        if let transcript = result.transcript, result.error == nil {
            notchModel.recordTranscript(transcript, conversationID: session.conversationID)
            var recognized: [String: Any] = [
                "status": "recognized",
                "transcript": transcript,
                "locale": result.locale,
                "started_at": result.startedAt ?? session.pressedAt,
                "ended_at": result.endedAt
            ]
            if let confidence = result.confidence { recognized["confidence"] = confidence }
            speech = recognized
            postDirectAssist(
                requestID: session.eventID,
                conversationID: session.conversationID,
                prompt: transcript,
                source: .voice,
                transcript: transcript,
                snapshot: session.snapshot,
                screenImage: session.screenImage
            )
        } else {
            notchModel.fail(
                result.error?.localizedDescription ?? "Doubao ASR returned no transcript.",
                conversationID: session.conversationID
            )
            speech = [
                "status": "failed",
                "code": "doubao_asr_failed",
                "message": result.error?.localizedDescription ?? "Doubao ASR returned no transcript.",
                "started_at": result.startedAt ?? session.pressedAt,
                "ended_at": result.endedAt
            ]
        }
        var payload: [String: Any] = [
            "version": 1,
            "event_id": session.eventID,
            "session_id": session.id,
            "source": [
                "connector": "metaflow-mac",
                "connection_id": ProcessInfo.processInfo.hostName
            ],
            "shortcut": [
                "phase": "released",
                "key_code": voiceShortcut.keyCode,
                "modifiers": shortcutModifierNames(voiceShortcut.carbonModifiers),
                "pressed_at": session.pressedAt,
                "released_at": releasedAt
            ],
            "speech": speech,
            "accessibility": ambientAccessibilityPayload(snapshot: session.snapshot, trusted: session.accessibilityTrusted),
            "captured_at": isoNow(),
            "privacy": [
                "owner": "user:local",
                "visibility": "private",
                "privacy": "private",
                "retention": "normal",
                "allow_external_model": allowExternalLlm,
                "allow_embedding": false,
                "labels": ["ambient", "macos", "voice"]
            ],
            "metadata": ["surface": "mac", "shortcut": voiceShortcut.displayName]
        ]
        if let transcript = result.transcript, let agent = requestedAgent(from: transcript) {
            payload["requested_agent"] = agent
        }
        NSLog("[metaflow] voice.transcribed event_id=%@ speech=%@", session.eventID, String(describing: speech["status"] ?? "unknown"))
    }

    private func submitTypedCommand(_ command: String, conversationID: String) {
        let (_, snapshot) = currentAssistAccessibilityContext()
        postDirectAssist(
            requestID: UUID().uuidString,
            conversationID: conversationID,
            prompt: command,
            source: .typed,
            transcript: nil,
            snapshot: snapshot,
            screenImage: startScreenCapture()
        )
    }

    private func postDirectAssist(
        requestID: String,
        conversationID: String,
        prompt: String,
        source: AmbientAssistSource,
        transcript: String?,
        snapshot: AccessibilitySnapshot?,
        screenImage: Task<AmbientScreenImage, Error>
    ) {
        notchModel.beginWorking(conversationID: conversationID)
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let capturedScreen = try await screenImage.value
                let result = try await assistClient.assist(
                    requestID: requestID,
                    conversationID: conversationID,
                    prompt: prompt,
                    source: source,
                    transcript: transcript,
                    snapshot: snapshot,
                    screenImage: capturedScreen,
                    agent: agentBackend,
                    onDelta: { [weak self] delta in
                        self?.notchModel.appendResponseDelta(delta, conversationID: conversationID)
                    },
                    onToolActivity: { [weak self] activity in
                        self?.notchModel.recordToolActivity(activity, conversationID: conversationID)
                    }
                )
                notchModel.complete(title: "Metaflow", text: result.text, conversationID: conversationID)
                updateStatus("Ready", detail: "Answer complete.", conversationID: conversationID)
            } catch {
                notchModel.fail(error.localizedDescription, conversationID: conversationID)
                updateStatus("Assist failed", detail: error.localizedDescription, conversationID: conversationID)
            }
        }
    }

    private func freezeNotchAccessibilityContext() {
        guard accessibilityTrusted(prompt: false),
              let app = NSWorkspace.shared.frontmostApplication,
              app.bundleIdentifier != Bundle.main.bundleIdentifier else { return }
        let name = app.localizedName ?? "Unknown app"
        let bundleIdentifier = app.bundleIdentifier ?? "unknown"
        let processIdentifier = app.processIdentifier
        let started = Date()
        let capture = Task.detached(priority: .userInitiated) {
            AccessibilitySnapshot.capture(
                appName: name,
                bundleIdentifier: bundleIdentifier,
                processIdentifier: processIdentifier
            )
        }
        Task { @MainActor [weak self] in
            let snapshot = await capture.value
            self?.frozenNotchSnapshot = snapshot
            self?.lastExternalSnapshot = snapshot
            NSLog(
                "[metaflow] assist.context_frozen app=%@ bundle_id=%@ elapsed_ms=%.1f",
                snapshot.appName,
                snapshot.bundleIdentifier,
                Date().timeIntervalSince(started) * 1_000
            )
        }
    }

    private func currentAssistAccessibilityContext() -> (trusted: Bool, snapshot: AccessibilitySnapshot?) {
        let trusted = accessibilityTrusted(prompt: false)
        guard trusted else { return (false, nil) }
        if let app = NSWorkspace.shared.frontmostApplication,
           app.bundleIdentifier != Bundle.main.bundleIdentifier {
            let snapshot = AccessibilitySnapshot.capture(app: app)
            lastExternalSnapshot = snapshot
            return (true, snapshot)
        }
        return (true, frozenNotchSnapshot ?? lastExternalSnapshot)
    }

    private func startScreenCapture() -> Task<AmbientScreenImage, Error> {
        let displayID = currentAmbientDisplayID()
        return Task { @MainActor [screenCapture] in
            try await screenCapture.capture(displayID: displayID)
        }
    }

    private func postAmbientVoice(_ payload: [String: Any]) {
        guard let url = ambientURL(path: "/automation/v1/macos/voice-signals") else {
            notchModel.fail("The configured Ambient endpoint is invalid.")
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        } catch {
            updateStatus("Voice request invalid", detail: error.localizedDescription)
            notchModel.fail(error.localizedDescription)
            return
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let authorized = try await authorizedAmbientRequest(request)
                let (data, response) = try await URLSession.shared.data(for: authorized)
                guard let http = response as? HTTPURLResponse else {
                    throw ResidentOperationAccessError.invalidResponse("Ambient daemon returned no HTTP response")
                }
                guard (200..<300).contains(http.statusCode) else {
                    let body = String(data: data, encoding: .utf8) ?? ""
                    throw ResidentOperationAccessError.invalidResponse("Voice request rejected (HTTP \(http.statusCode)): \(body)")
                }
                notchModel.beginWorking("ACP accepted the exact voice and foreground Views")
                updateStatus("Agent working", detail: "The exact voice and foreground Views were accepted.")
            } catch {
                updateStatus("Ambient daemon request failed", detail: error.localizedDescription)
                notchModel.fail("Ambient daemon request failed: \(error.localizedDescription)")
            }
        }
    }

    private func pollAmbientDeliveries() {
        guard !ambientPollInFlight else { return }
        guard let url = ambientURL(path: "/automation/v1/macos/deliveries") else { return }
        ambientPollInFlight = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { ambientPollInFlight = false }
            do {
                let authorized = try await authorizedAmbientRequest(URLRequest(url: url))
                let (data, response) = try await URLSession.shared.data(for: authorized)
                guard let http = response as? HTTPURLResponse else {
                    throw ResidentOperationAccessError.invalidResponse("No HTTP response was returned")
                }
                guard http.statusCode == 200 else {
                    throw ResidentOperationAccessError.invalidResponse(
                        String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
                    )
                }
                let cards = try AmbientDeliveryCard.list(from: data)
                lastAmbientPollFailure = ""
                guard let card = cards.last else { return }
                showAmbientCard(card)
            } catch {
                recordAmbientPollFailure(code: "authorized_transport", detail: error.localizedDescription)
            }
        }
    }

    private func recordAmbientPollFailure(code: String, detail: String) {
        let fingerprint = "\(code):\(detail)"
        guard fingerprint != lastAmbientPollFailure else { return }
        lastAmbientPollFailure = fingerprint
        detailLabel?.stringValue = "Ambient Delivery poll failed: \(detail)"
        NSLog("[metaflow] ambient.delivery.poll_failed code=%@ detail=%@", code, detail)
    }

    private func showAmbientCard(_ card: AmbientDeliveryCard) {
        guard latestAmbientCard?.deliveryID != card.deliveryID else { return }
        latestAmbientCard = card
        notchModel.showDelivery(card)
        switch card.phase {
        case "accepted", "progress":
            suggestionTitleLabel.stringValue = "Agent working"
            suggestionBodyLabel.stringValue = "Using the frozen utterance and current app context."
            copyButton.title = "Cancel"
            copyButton.isEnabled = card.actions.contains("cancel")
            dismissButton.title = "Dismiss"
            dismissButton.isEnabled = card.actions.contains("dismiss")
            notchPanel.show()
        case "result", "failure":
            copyButton.title = "Copy"
            dismissButton.title = "Dismiss"
            copyButton.isEnabled = card.phase == "result"
            dismissButton.isEnabled = card.actions.contains("dismiss")
            loadAmbientResult(card)
        default:
            updateStatus("Unknown Delivery phase", detail: card.phase)
        }
    }

    private func loadAmbientResult(_ card: AmbientDeliveryCard) {
        guard
            let first = card.views.first,
            let viewID = first["view_id"] as? String,
            let revision = first["revision"] as? Int
        else {
            suggestionTitleLabel.stringValue = card.phase == "failure" ? "Agent failed" : "Agent result"
            suggestionBodyLabel.stringValue = "No exact result View was attached."
            notchModel.fail("No exact result View was attached to the Delivery.")
            return
        }
        guard
            let operationAuthToken,
            operationAuthToken.range(
                of: #"^[A-Za-z0-9._~+/-]{32,}=*$"#,
                options: .regularExpression
            ) != nil
        else {
            suggestionTitleLabel.stringValue = card.phase == "failure" ? "Agent failed" : "Agent result"
            suggestionBodyLabel.stringValue = "Exact View access is not configured."
            notchModel.fail("A valid resident daemon Operation token is required.")
            return
        }
        let accessClient: ResidentOperationAccessClient
        do {
            accessClient = try ResidentOperationAccessClient(endpoint: ambientEndpoint, token: operationAuthToken)
        } catch {
            suggestionBodyLabel.stringValue = error.localizedDescription
            notchModel.fail(error.localizedDescription)
            return
        }
        let phase = card.phase
        Task { [weak self] in
            do {
                let data = try await accessClient.loadExactView(viewID: viewID, revision: revision)
                let text = ambientResultText(data) ?? String(data: data, encoding: .utf8) ?? "Unreadable result View"
                self?.latestSuggestion = WritingSuggestion(id: viewID, viewType: phase, title: phase == "failure" ? "Agent failed" : "Agent result", text: text)
                self?.suggestionTitleLabel.stringValue = phase == "failure" ? "Agent failed" : "Agent result"
                self?.suggestionBodyLabel.stringValue = text
                if phase == "failure" {
                    self?.notchModel.fail(text)
                } else {
                    self?.notchModel.complete(title: "Agent result", text: text)
                }
                self?.notchPanel.show()
            } catch {
                self?.suggestionBodyLabel.stringValue = error.localizedDescription
                self?.notchModel.fail(error.localizedDescription)
            }
        }
    }

    private func postAmbientInteraction(action: String) {
        guard let card = latestAmbientCard, card.actions.contains(action) else {
            notchModel.fail("The requested action is not available on the current Delivery.")
            return
        }
        guard let url = ambientURL(path: "/automation/v1/macos/interactions") else {
            notchModel.fail("The configured Ambient endpoint is invalid.")
            return
        }
        let payload: [String: Any] = [
            "id": UUID().uuidString,
            "request_id": card.requestID,
            "delivery_id": card.deliveryID,
            "surface": card.surface,
            "action": action,
            "occurred_at": isoNow(),
            "actor": "user:mac",
            "metadata": ["correlation_id": card.correlationID]
        ]
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        } catch {
            notchModel.fail("Could not encode the Delivery interaction: \(error.localizedDescription)")
            return
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let authorized = try await authorizedAmbientRequest(request)
                let (data, response) = try await URLSession.shared.data(for: authorized)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    throw ResidentOperationAccessError.invalidResponse(
                        String(data: data, encoding: .utf8) ?? "Delivery interaction was rejected"
                    )
                }
                latestAmbientCard = nil
                notchModel.availableActions = []
                if action == "dismiss" || action == "cancel" { notchModel.reset() }
                updateStatus(
                    action == "cancel" ? "Cancellation requested" : "Feedback recorded",
                    detail: "The interaction is linked to the exact Automation Run."
                )
            } catch {
                updateStatus("Interaction failed", detail: error.localizedDescription)
                notchModel.fail("Interaction failed: \(error.localizedDescription)")
            }
        }
    }

    private func ambientURL(path: String) -> URL? {
        guard var components = URLComponents(url: ambientEndpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = path
        components.queryItems = nil
        return components.url
    }

    private func authorizedAmbientRequest(_ request: URLRequest) async throws -> URLRequest {
        guard let operationAuthToken else { throw ResidentOperationAccessError.invalidToken }
        let access = try ResidentOperationAccessClient(endpoint: ambientEndpoint, token: operationAuthToken)
        return try await access.authorize(request)
    }

    private func ambientExactViewURL(viewID: String, revision: Int) -> URL? {
        metaflowExactViewURL(base: ambientEndpoint, viewID: viewID, revision: revision)
    }

    private func refreshAccessibilityStatus(prompt: Bool) {
        if accessibilityTrusted(prompt: prompt) {
            updateStatus("Accessibility enabled", detail: "Watching focused controls.")
        } else {
            updateStatus("Accessibility permission needed", detail: "Grant permission in System Settings to observe local app focus and text.")
        }
    }

    private func accessibilityTrusted(prompt: Bool) -> Bool {
        let options = ["AXTrustedCheckOptionPrompt": prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    private func updateStatus(_ status: String, detail: String, conversationID: String? = nil) {
        statusLabel?.stringValue = status
        detailLabel?.stringValue = detail
        notchModel.markReady(detail, conversationID: conversationID)
    }

    private func positionPanel() {
        panel.center()
    }

    @objc private func togglePanel() {
        panel.isVisible ? panel.orderOut(nil) : showPanel()
    }

    @objc private func showNotch() {
        notchModel.open()
        notchPanel.show()
    }

    @objc private func showPanel() {
        positionPanel()
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func requestAccessibilityPermission() {
        refreshAccessibilityStatus(prompt: true)
        registerPushToTalk()
        showNotch()
    }

    @objc private func requestVoicePermissions() {
        Task { @MainActor in
            do {
                _ = try SpeechTranscriberFactory.make()
                let granted = await AVCaptureDevice.requestAccess(for: .audio)
                guard granted else { throw AmbientVoiceError.microphonePermissionDenied }
                updateStatus("Voice ready", detail: "Doubao ASR is configured and Microphone is authorized.")
            } catch {
                updateStatus("Voice permissions unavailable", detail: error.localizedDescription)
            }
            showNotch()
        }
    }

    @objc private func showVoiceShortcutSettings() {
        voiceShortcutSettings.show(current: voiceShortcut, agent: agentBackend) { [weak self] configuration, agent in
            guard let self else { return }
            do {
                try self.voiceShortcutStore.save(configuration)
                try self.agentBackendStore.save(agent)
                self.voiceShortcut = configuration
                self.agentBackend = agent
                self.notchModel.shortcutLabel = configuration.displayName
                self.registerPushToTalk()
                self.updateStatus("Settings updated", detail: "\(configuration.displayName) · \(agent.displayName)")
            } catch {
                self.notchModel.fail("Could not save the voice shortcut: \(error.localizedDescription)")
            }
        }
    }

    @objc private func toggleCapture(_ sender: Any? = nil) {
        running.toggle()
        updateStatus(running ? "Capture running" : "Capture paused", detail: running ? "Watching focused controls." : "No local app Observations will be sent.")
    }

    @objc private func copySuggestion() {
        if let card = latestAmbientCard, card.phase == "accepted" || card.phase == "progress" {
            postAmbientInteraction(action: "cancel")
            return
        }
        guard let suggestion = latestSuggestion else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(suggestion.text, forType: .string)
        if latestAmbientCard != nil {
            postAmbientInteraction(action: "accept")
            updateStatus("Agent result copied", detail: "Feedback is linked to the exact Automation Run.")
            return
        }
        postFeedback(for: suggestion, type: "analysis.useful", value: "copied", reason: "Copied mac writing suggestion.")
        updateStatus("Suggestion copied", detail: "Paste it into the target app when ready.")
    }

    private func copyNotchResult() {
        let text = notchModel.resultText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        if latestAmbientCard?.actions.contains("accept") == true {
            postAmbientInteraction(action: "accept")
        }
        updateStatus("Agent result copied", detail: "The exact result is on the clipboard.")
    }

    @objc private func dismissSuggestion() {
        if latestAmbientCard != nil {
            postAmbientInteraction(action: "dismiss")
            latestSuggestion = nil
            suggestionTitleLabel.stringValue = "AI writing suggestion"
            suggestionBodyLabel.stringValue = "Agent result dismissed."
            copyButton.isEnabled = false
            dismissButton.isEnabled = false
            return
        }
        guard let suggestion = latestSuggestion else { return }
        postFeedback(for: suggestion, type: "analysis.dismissed", value: "dismissed", reason: "Dismissed mac writing suggestion.")
        latestSuggestion = nil
        suggestionTitleLabel.stringValue = "AI writing suggestion"
        suggestionBodyLabel.stringValue = "Suggestion dismissed. Keep typing to generate a new one."
        copyButton.isEnabled = false
        dismissButton.isEnabled = false
    }

    private func postFeedback(for suggestion: WritingSuggestion, type: String, value: String, reason: String) {
        guard let url = feedbackURL() else { return }
        let payload: [String: Any] = [
            "type": type,
            "application_id": "mac",
            "view_id": suggestion.id,
            "value": value,
            "reason": reason,
            "payload": [
                "surface": "mac",
                "target_view_type": suggestion.viewType,
                "suggestion_text": suggestion.text,
            ],
        ]
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        URLSession.shared.dataTask(with: request).resume()
    }

    @objc private func quit() {
        globalPushToTalk?.stop()
        ambientTimer?.invalidate()
        speechRecognizer.cancel()
        NSApp.terminate(nil)
    }
}

struct WritingSuggestion {
    let id: String
    let viewType: String
    let title: String
    let text: String

    static func latest(from data: Data) -> WritingSuggestion? {
        guard
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let views = json["views"] as? [[String: Any]]
        else { return nil }

        for view in views {
            guard
                let id = view["id"] as? String,
                let viewType = view["view_type"] as? String
            else { continue }
            let content = view["content"] as? [String: Any] ?? [:]
            let title = (view["title"] as? String) ?? (viewType == "draft.writing_continuation" ? "AI draft" : "AI writing")
            let draft = content["draft_text"] as? String
            let suggestions = content["suggestions"] as? [String]
            let summary = view["summary"] as? String
            let text = [draft, suggestions?.first, summary]
                .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .first { !$0.isEmpty }
            if let text {
                return WritingSuggestion(id: id, viewType: viewType, title: title, text: text)
            }
        }
        return nil
    }

    static func single(from data: Data) -> WritingSuggestion? {
        guard
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let view = json["view"] as? [String: Any]
        else { return nil }
        return from(view: view)
    }

    private static func from(view: [String: Any]) -> WritingSuggestion? {
        guard
            let id = view["id"] as? String,
            let viewType = view["view_type"] as? String
        else { return nil }
        let content = view["content"] as? [String: Any] ?? [:]
        let title = (view["title"] as? String) ?? (viewType == "draft.writing_continuation" ? "AI draft" : "AI writing")
        let draft = content["draft_text"] as? String
        let suggestions = content["suggestions"] as? [String]
        let summary = view["summary"] as? String
        let text = [draft, suggestions?.first, summary]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        guard let text else { return nil }
        return WritingSuggestion(id: id, viewType: viewType, title: title, text: text)
    }
}

private final class WritingSuggestionAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var suggestionsById: [String: WritingSuggestion] = [:]

    func insert(_ suggestion: WritingSuggestion) {
        lock.withLock {
            suggestionsById[suggestion.id] = suggestion
        }
    }

    func first(in orderedIds: [String]) -> WritingSuggestion? {
        lock.withLock {
            orderedIds.compactMap { suggestionsById[$0] }.first
        }
    }
}

struct IngestResponse {
    static func writingViewIds(from data: Data) -> [String]? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        var ids: [String] = []
        collectRunViewIds(json["processing"], into: &ids)
        if let cascade = json["cascade_processing"] as? [[String: Any]] {
            for item in cascade {
                collectRunViewIds(item, into: &ids)
            }
        }
        let writingIds = ids.filter { $0.contains("writing") }
        return writingIds.isEmpty ? nil : Array(Set(writingIds))
    }

    private static func collectRunViewIds(_ value: Any?, into ids: inout [String]) {
        guard let object = value as? [String: Any], let runs = object["runs"] as? [[String: Any]] else { return }
        for run in runs {
            if let runIds = run["written_views"] as? [String] {
                ids.append(contentsOf: runIds)
            }
        }
    }
}

@main
@MainActor
enum MetaflowMacMain {
    private static var delegate: MetaflowMac?

    static func main() {
        if CommandLine.arguments.contains("--permission-smoke") {
            runPermissionSmoke()
            return
        }
        if CommandLine.arguments.contains("--ax-smoke") {
            runAccessibilitySmoke()
            return
        }
        if CommandLine.arguments.contains("--asr-smoke") {
            runASRSmoke()
            return
        }
        if CommandLine.arguments.contains("--screen-smoke") {
            runScreenSmoke()
            return
        }
        let app = NSApplication.shared
        let appDelegate = MetaflowMac()
        delegate = appDelegate
        app.delegate = appDelegate
        app.run()
    }

    private static func runAccessibilitySmoke() {
        let trusted = AXIsProcessTrusted()
        let snapshot = trusted ? NSWorkspace.shared.frontmostApplication.map(AccessibilitySnapshot.capture) : nil
        let evaluation = evaluateAccessibilitySmoke(
            trusted: trusted,
            snapshot: snapshot,
            requireSelectedText: CommandLine.arguments.contains("--require-selected-text")
        )
        printSmokeJson(evaluation.output)
        if evaluation.exitCode != 0 { exit(evaluation.exitCode) }
    }

    private static func runPermissionSmoke() {
        let permissions = [
            "accessibility": AXIsProcessTrusted() ? "authorized" : "denied",
            "microphone": microphoneAuthorizationLabel(AVCaptureDevice.authorizationStatus(for: .audio))
        ]
        let ready = permissions.values.allSatisfy { $0 == "authorized" }
        var output: [String: Any] = [
            "ok": ready,
            "captured_at": isoNow(),
            "permissions": permissions
        ]
        if !ready {
            output["code"] = "permissions_not_ready"
            output["message"] = "Accessibility and Microphone permissions must both be authorized."
        }
        printSmokeJson(output)
        if !ready { exit(5) }
    }

    private static func runASRSmoke() {
        let duration = Double(ProcessInfo.processInfo.environment["METAFLOW_ASR_SMOKE_SECONDS"] ?? "5") ?? 5
        guard duration >= 1, duration <= 30 else {
            printSmokeJson([
                "ok": false,
                "code": "invalid_asr_smoke_duration",
                "message": "METAFLOW_ASR_SMOKE_SECONDS must be between 1 and 30."
            ])
            exit(6)
        }
        Task { @MainActor in
            let started = Date()
            do {
                let transcriber = try SpeechTranscriberFactory.make()
                try await transcriber.start()
                try await Task.sleep(for: .milliseconds(Int(duration * 1_000)))
                let transcript = normalize(try await transcriber.finish())
                guard !transcript.isEmpty else { throw AmbientVoiceError.emptyTranscript }
                printSmokeJson([
                    "ok": true,
                    "provider": "doubao_realtime_asr",
                    "elapsed_ms": Date().timeIntervalSince(started) * 1_000,
                    "transcript": transcript
                ])
                exit(0)
            } catch {
                printSmokeJson([
                    "ok": false,
                    "code": "doubao_asr_smoke_failed",
                    "elapsed_ms": Date().timeIntervalSince(started) * 1_000,
                    "message": error.localizedDescription
                ])
                exit(7)
            }
        }
        RunLoop.main.run()
    }

    private static func runScreenSmoke() {
        Task { @MainActor in
            let started = Date()
            do {
                let image = try await AmbientScreenCaptureService().capture(displayID: currentAmbientDisplayID())
                if let path = ProcessInfo.processInfo.environment["METAFLOW_SCREEN_SMOKE_OUTPUT"], !path.isEmpty {
                    try image.data.write(to: URL(fileURLWithPath: path), options: .atomic)
                }
                printSmokeJson([
                    "ok": true,
                    "mime_type": image.mimeType,
                    "bytes": image.data.count,
                    "elapsed_ms": Date().timeIntervalSince(started) * 1_000
                ])
                exit(0)
            } catch {
                printSmokeJson([
                    "ok": false,
                    "code": "screen_capture_failed",
                    "elapsed_ms": Date().timeIntervalSince(started) * 1_000,
                    "message": error.localizedDescription
                ])
                exit(8)
            }
        }
        RunLoop.main.run()
    }
}

struct AccessibilitySmokeEvaluation {
    let output: [String: Any]
    let exitCode: Int32
}

func evaluateAccessibilitySmoke(
    trusted: Bool,
    snapshot: AccessibilitySnapshot?,
    requireSelectedText: Bool,
    capturedAt: String = isoNow()
) -> AccessibilitySmokeEvaluation {
    guard trusted else {
        return AccessibilitySmokeEvaluation(output: [
            "ok": false,
            "code": "accessibility_permission_denied",
            "message": "Accessibility permission is required."
        ], exitCode: 2)
    }
    guard let snapshot else {
        return AccessibilitySmokeEvaluation(output: [
            "ok": false,
            "code": "frontmost_application_unavailable",
            "message": "No frontmost application is available to Accessibility."
        ], exitCode: 3)
    }
    let accessibility = ambientAccessibilityPayload(snapshot: snapshot, trusted: true)
    if requireSelectedText && normalize(snapshot.selectedText ?? "").isEmpty {
        return AccessibilitySmokeEvaluation(output: [
            "ok": false,
            "code": "selected_text_unavailable",
            "message": "Select non-empty text in the frontmost application and retry.",
            "captured_at": capturedAt,
            "likely_screen_locked": snapshot.bundleIdentifier == "com.apple.loginwindow",
            "accessibility": accessibility
        ], exitCode: 4)
    }
    return AccessibilitySmokeEvaluation(output: [
        "ok": true,
        "captured_at": capturedAt,
        "accessibility": accessibility
    ], exitCode: 0)
}

func microphoneAuthorizationLabel(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not_determined"
    @unknown default: return "unknown"
    }
}

private func printSmokeJson(_ output: [String: Any]) {
    do {
        let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
        guard let text = String(data: data, encoding: .utf8) else {
            fatalError("Failed to encode smoke output as UTF-8")
        }
        print(text)
    } catch {
        fatalError("Failed to serialize smoke output: \(error)")
    }
}

struct AccessibilitySnapshot: Sendable {
    let appName: String
    let bundleIdentifier: String
    let processIdentifier: pid_t
    let windowTitle: String?
    let role: String?
    let subrole: String?
    let focusedValue: String?
    let selectedText: String?
    let description: String?
    let placeholder: String?

    var focusKey: String {
        [bundleIdentifier, windowTitle, role, subrole, description, placeholder].compactMap { $0 }.joined(separator: "|")
    }

    var focusSummary: String {
        [appName, windowTitle, roleDescription].compactMap { $0 }.joined(separator: " · ")
    }

    var roleDescription: String {
        [role, subrole, description, placeholder].compactMap { value in
            guard let value else { return nil }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }.joined(separator: " · ")
    }

    var bestEditableText: String? {
        let roleValue = (role ?? "").lowercased()
        if let selectedText, normalize(selectedText).count >= 8 { return selectedText }
        if let focusedValue, normalize(focusedValue).count >= 8 { return focusedValue }
        guard roleValue.contains("text") || roleValue.contains("area") else { return nil }
        return nil
    }

    var isSensitive: Bool {
        let haystack = [windowTitle, role, subrole, description, placeholder, bundleIdentifier]
            .compactMap { $0 }
            .joined(separator: " ")
        return haystack.range(of: #"password|token|secret|api[_-]?key|credit card|验证码|密码|one-time|otp"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func capture(app: NSRunningApplication) -> AccessibilitySnapshot {
        capture(
            appName: app.localizedName ?? "Unknown app",
            bundleIdentifier: app.bundleIdentifier ?? "unknown",
            processIdentifier: app.processIdentifier
        )
    }

    static func capture(appName: String, bundleIdentifier: String, processIdentifier: pid_t) -> AccessibilitySnapshot {
        let appElement = AXUIElementCreateApplication(processIdentifier)
        let window: AXUIElement? = axValue(appElement, kAXFocusedWindowAttribute)
        let focused: AXUIElement? = axValue(appElement, kAXFocusedUIElementAttribute)
        return AccessibilitySnapshot(
            appName: appName,
            bundleIdentifier: bundleIdentifier,
            processIdentifier: processIdentifier,
            windowTitle: axString(window, kAXTitleAttribute),
            role: axString(focused, kAXRoleAttribute),
            subrole: axString(focused, kAXSubroleAttribute),
            focusedValue: axString(focused, kAXValueAttribute),
            selectedText: axString(focused, kAXSelectedTextAttribute),
            description: axString(focused, kAXDescriptionAttribute),
            placeholder: axString(focused, kAXPlaceholderValueAttribute)
        )
    }

    func payload(kind: String) -> [String: JSONValue] {
        var value: [String: JSONValue] = [
            "kind": .string(kind),
            "app_name": .string(appName),
            "bundle_identifier": .string(bundleIdentifier),
            "process_id": .number(Double(processIdentifier)),
            "observed_at": .string(isoNow())
        ]
        if let windowTitle { value["window_title"] = .string(windowTitle) }
        if let role { value["role"] = .string(role) }
        if let subrole { value["subrole"] = .string(subrole) }
        if let description { value["field_description"] = .string(description) }
        if let placeholder { value["field_placeholder"] = .string(placeholder) }
        if let selectedText { value["selected_text"] = .string(String(selectedText.prefix(2_000))) }
        value["role_description"] = .string(roleDescription)
        return value
    }
}

struct ContextRecord: Encodable {
    let schema: Schema
    let source: Source
    let scope: Scope
    let time: RecordTime
    let content: Content
    let acquisition: Acquisition
    let signal: Signal
    let privacy: Privacy
    let payload: [String: JSONValue]
}

struct Schema: Encodable {
    let name: String
    let version: Int
}

struct Source: Encodable {
    let type: String
    let connector: String
}

struct Scope: Encodable {
    let app: String?
    let domain: String?
}

struct RecordTime: Encodable {
    let observed_at: String
    let captured_at: String
}

struct Content: Encodable {
    let title: String?
    let url: String?
    let text: String?
}

struct Acquisition: Encodable {
    let mode: String
    let actor: String
    let reason: String
}

struct Signal: Encodable {
    let importance: Double
    let confidence: Double
    let status: String
}

struct Privacy: Encodable {
    let level: String
    let retention: String
    let allow_external_llm: Bool
}

enum JSONValue: Encodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

extension JSONEncoder {
    static let contextEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()
}

private func axValue<T>(_ element: AXUIElement?, _ attribute: String) -> T? {
    guard let element else { return nil }
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard result == .success else { return nil }
    return value as? T
}

private func axString(_ element: AXUIElement?, _ attribute: String) -> String? {
    let value: AnyObject? = axValue(element, attribute)
    if let string = value as? String { return string }
    if let attributed = value as? NSAttributedString { return attributed.string }
    return nil
}

func normalize(_ text: String) -> String {
    text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

func isoNow() -> String {
    isoTimestamp(Date())
}

func isoTimestamp(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

func metaflowExactViewURL(base: URL, viewID: String, revision: Int) -> URL? {
    guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
    components.path = "/context/v1/views/\(viewID)"
    components.queryItems = [URLQueryItem(name: "revision", value: String(revision))]
    return components.url
}

private func shortcutModifierNames(_ modifiers: UInt32) -> [String] {
    var names: [String] = []
    if modifiers & UInt32(controlKey) != 0 { names.append("control") }
    if modifiers & UInt32(optionKey) != 0 { names.append("option") }
    if modifiers & UInt32(shiftKey) != 0 { names.append("shift") }
    if modifiers & UInt32(cmdKey) != 0 { names.append("command") }
    return names
}
