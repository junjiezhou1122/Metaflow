import AppKit
import Foundation
import MarkdownUI
import Observation
import OSLog

enum MetaflowNotchPhase: String, Equatable {
    case idle
    case preparingVoice
    case listening
    case transcribing
    case working
    case needsApproval
    case done
    case error
}

enum MetaflowNotchPresentation: Equatable, Sendable {
    case docked
    case expanded
}

enum MetaflowContentChange: Equatable, Sendable {
    case immediate
    case throttled
}

struct MetaflowNotchMessage: Identifiable, Equatable, Codable {
    enum Role: String, Codable {
        case user
        case assistant
    }

    let id: UUID
    let role: Role
    var text: String {
        didSet { markdownContent = MarkdownContent(text) }
    }
    let isError: Bool
    private(set) var markdownContent: MarkdownContent

    init(id: UUID = UUID(), role: Role, text: String, isError: Bool) {
        self.id = id
        self.role = role
        self.text = text
        self.isError = isError
        markdownContent = MarkdownContent(text)
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case role
        case text
        case isError
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        role = try container.decode(Role.self, forKey: .role)
        text = try container.decode(String.self, forKey: .text)
        isError = try container.decode(Bool.self, forKey: .isError)
        markdownContent = MarkdownContent(text)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(role, forKey: .role)
        try container.encode(text, forKey: .text)
        try container.encode(isError, forKey: .isError)
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id
            && lhs.role == rhs.role
            && lhs.text == rhs.text
            && lhs.isError == rhs.isError
    }
}

struct MetaflowToolActivity: Identifiable, Equatable {
    let id: String
    var title: String?
    var kind: String?
    var status: String?
    var toolName: String?

    init(_ event: AmbientToolActivityEvent) {
        id = event.toolCallID
        title = event.title
        kind = event.kind
        status = event.status
        toolName = event.toolName
    }

    mutating func merge(_ event: AmbientToolActivityEvent) {
        precondition(id == event.toolCallID, "Cannot merge different tool calls")
        title = event.title ?? title
        kind = event.kind ?? kind
        status = event.status ?? status
        toolName = event.toolName ?? toolName
    }
}

@MainActor
struct MetaflowConversationStore {
    private static let logger = Logger(
        subsystem: "com.metaflow.mac.visible",
        category: "ConversationStore"
    )
    private static let legacySuite = "com.metaflow.mac-companion.visible"

    static let live = MetaflowConversationStore(
        defaults: .standard,
        legacyDefaults: UserDefaults(suiteName: legacySuite),
        fileURL: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Metaflow", isDirectory: true)
            .appendingPathComponent("conversations-v1.json", isDirectory: false)
    )

    let defaults: UserDefaults
    let legacyDefaults: UserDefaults?
    let fileURL: URL?
    let key: String

    init(
        defaults: UserDefaults,
        legacyDefaults: UserDefaults? = nil,
        fileURL: URL? = nil,
        key: String = "metaflow.notch.conversations.v1"
    ) {
        self.defaults = defaults
        self.legacyDefaults = legacyDefaults
        self.fileURL = fileURL
        self.key = key
    }

    func load() throws -> [MetaflowConversationSnapshot] {
        if let fileURL, FileManager.default.fileExists(atPath: fileURL.path) {
            return try decode(Data(contentsOf: fileURL))
        }
        if let data = defaults.data(forKey: key) {
            return try migrate(data, source: "current_preferences")
        }
        if let data = legacyDefaults?.data(forKey: key) {
            return try migrate(data, source: "legacy_preferences")
        }
        return []
    }

    func save(_ snapshots: [MetaflowConversationSnapshot]) throws {
        let data = try JSONEncoder().encode(snapshots)
        if let fileURL {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: fileURL, options: .atomic)
        } else {
            defaults.set(data, forKey: key)
        }
    }

    private func migrate(_ data: Data, source: String) throws -> [MetaflowConversationSnapshot] {
        let snapshots = try decode(data)
        if fileURL != nil {
            try save(snapshots)
            Self.logger.notice(
                "conversation history migrated source=\(source, privacy: .public) conversations=\(snapshots.count) bytes=\(data.count)"
            )
        }
        return snapshots
    }

    private func decode(_ data: Data) throws -> [MetaflowConversationSnapshot] {
        try JSONDecoder().decode([MetaflowConversationSnapshot].self, from: data)
    }
}

struct MetaflowConversationSnapshot: Codable, Equatable {
    let id: String
    let title: String
    let createdAt: Date
    let updatedAt: Date
    let messages: [MetaflowNotchMessage]
    let resultTitle: String
    let resultText: String
}

@MainActor
@Observable
final class MetaflowNotchConversation: Identifiable {
    let id: String
    var title: String
    let createdAt: Date
    var updatedAt: Date
    var phase: MetaflowNotchPhase
    var detail: String
    var resultTitle: String
    var resultText: String
    var messages: [MetaflowNotchMessage]
    var toolActivities: [MetaflowToolActivity] = []
    var availableActions: Set<String> = []
    var isSending = false

    @ObservationIgnored var streamingMessageID: UUID?
    @ObservationIgnored var bufferedResponse = ""
    @ObservationIgnored var streamRevealTask: Task<Void, Never>?
    @ObservationIgnored var streamRenderTask: Task<Void, Never>?
    @ObservationIgnored var isToolMode = false

    init(
        id: String,
        title: String = "New conversation",
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        phase: MetaflowNotchPhase = .idle,
        detail: String = "Ready",
        resultTitle: String = "Metaflow",
        resultText: String = "",
        messages: [MetaflowNotchMessage] = []
    ) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.phase = phase
        self.detail = detail
        self.resultTitle = resultTitle
        self.resultText = resultText
        self.messages = messages
    }

    convenience init(snapshot: MetaflowConversationSnapshot) {
        self.init(
            id: snapshot.id,
            title: snapshot.title,
            createdAt: snapshot.createdAt,
            updatedAt: snapshot.updatedAt,
            phase: snapshot.messages.isEmpty ? .idle : .done,
            detail: "Ready",
            resultTitle: snapshot.resultTitle,
            resultText: snapshot.resultText,
            messages: snapshot.messages
        )
    }

    var snapshot: MetaflowConversationSnapshot {
        MetaflowConversationSnapshot(
            id: id,
            title: title,
            createdAt: createdAt,
            updatedAt: updatedAt,
            messages: messages.filter { !$0.text.isEmpty },
            resultTitle: resultTitle,
            resultText: resultText
        )
    }

    var preview: String {
        messages.last(where: { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })?.text
            .replacingOccurrences(of: "\n", with: " ") ?? "No messages yet"
    }
}

@MainActor
@Observable
final class MetaflowNotchModel {
    private static let navigationLogger = Logger(
        subsystem: "com.metaflow.mac.visible",
        category: "ConversationNavigation"
    )

    var presentation: MetaflowNotchPresentation = .docked {
        didSet {
            guard oldValue != presentation else { return }
            onPresentationChange?(presentation)
        }
    }
    var inputText = ""
    var shortcutLabel = "Hold Right Option"
    private(set) var conversations: [MetaflowNotchConversation]
    private(set) var selectedConversationID: String
    private(set) var isConversationPickerPresented = false

    @ObservationIgnored var onPresentationChange: ((MetaflowNotchPresentation) -> Void)?
    @ObservationIgnored var onContentChange: ((MetaflowContentChange) -> Void)?
    @ObservationIgnored var onWillOpen: (() -> Void)?
    @ObservationIgnored var onSubmitText: ((String, String) -> Void)?
    @ObservationIgnored var onStartVoice: (() -> Void)?
    @ObservationIgnored var onStopVoice: (() -> Void)?
    @ObservationIgnored var onCopy: (() -> Void)?
    @ObservationIgnored var onAction: ((String) -> Void)?
    @ObservationIgnored var onRequestPermissions: (() -> Void)?
    @ObservationIgnored private let streamRevealDelayNanoseconds: UInt64
    @ObservationIgnored private let streamRenderIntervalNanoseconds: UInt64
    @ObservationIgnored private let conversationStore: MetaflowConversationStore?

    init(
        streamRevealDelayNanoseconds: UInt64 = 500_000_000,
        streamRenderIntervalNanoseconds: UInt64 = 50_000_000,
        conversationStore: MetaflowConversationStore? = nil
    ) {
        self.streamRevealDelayNanoseconds = streamRevealDelayNanoseconds
        self.streamRenderIntervalNanoseconds = streamRenderIntervalNanoseconds
        self.conversationStore = conversationStore
        let restored: [MetaflowNotchConversation]
        do {
            restored = try conversationStore?.load().map(MetaflowNotchConversation.init(snapshot:)) ?? []
        } catch {
            preconditionFailure("Could not restore Metaflow conversations: \(error.localizedDescription)")
        }
        if let latest = restored.max(by: { $0.updatedAt < $1.updatedAt }) {
            conversations = restored
            selectedConversationID = latest.id
        } else {
            let initial = MetaflowNotchConversation(id: "metaflow-notch")
            conversations = [initial]
            selectedConversationID = initial.id
        }
    }

    var selectedConversation: MetaflowNotchConversation {
        conversation(withID: selectedConversationID)
    }

    var sortedConversations: [MetaflowNotchConversation] {
        conversations.sorted { lhs, rhs in
            if lhs.updatedAt == rhs.updatedAt { return lhs.createdAt > rhs.createdAt }
            return lhs.updatedAt > rhs.updatedAt
        }
    }

    var phase: MetaflowNotchPhase { selectedConversation.phase }
    var detail: String { selectedConversation.detail }
    var resultTitle: String { selectedConversation.resultTitle }
    var resultText: String { selectedConversation.resultText }
    var messages: [MetaflowNotchMessage] { selectedConversation.messages }
    var currentTurnMessages: [MetaflowNotchMessage] {
        guard let start = messages.lastIndex(where: { $0.role == .user }) else { return messages }
        return Array(messages[start...])
    }
    var earlierMessageCount: Int { messages.count - currentTurnMessages.count }
    var toolActivities: [MetaflowToolActivity] { selectedConversation.toolActivities }
    var isSending: Bool { selectedConversation.isSending }
    var availableActions: Set<String> {
        get { selectedConversation.availableActions }
        set {
            selectedConversation.availableActions = newValue
            notifyContentChange()
        }
    }

    var statusLine: String {
        switch phase {
        case .idle:
            let backgroundCount = conversations.filter { $0.id != selectedConversationID && $0.isSending }.count
            return backgroundCount == 0 ? "Ready" : "\(backgroundCount) conversation\(backgroundCount == 1 ? "" : "s") working"
        case .preparingVoice: return "Connecting voice"
        case .listening: return "Listening"
        case .transcribing: return "Transcribing"
        case .working: return hasStreamingText(in: selectedConversation) ? "Answering" : "Metaflow is working"
        case .needsApproval: return "Approval needed"
        case .done: return resultTitle
        case .error: return "Something failed"
        }
    }

    var expandedHeight: CGFloat {
        if phase == .listening || phase == .preparingVoice || phase == .transcribing { return 176 }
        if isConversationPickerPresented { return 466 }
        if messages.isEmpty { return 248 }
        let currentTurn = currentTurnMessages
        let userRows = currentTurn.filter { $0.role == .user }.count
        let assistantText = currentTurn.last(where: { $0.role == .assistant })?.text ?? resultText
        let assistantLines = max(2, min(11, Int(ceil(Double(assistantText.count) / 56.0))))
        let toolRows = min(toolActivities.count, 5)
        let estimated = 178 + CGFloat(userRows * 46) + CGFloat(assistantLines * 22) + CGFloat(toolRows * 34)
        return min(540, max(286, estimated))
    }

    var showsActivity: Bool {
        phase == .preparingVoice
            || phase == .listening
            || phase == .transcribing
            || (phase == .working && !hasStreamingText(in: selectedConversation))
    }

    @discardableResult
    func newConversation() -> String {
        let startedAt = CFAbsoluteTimeGetCurrent()
        let conversation = MetaflowNotchConversation(id: "metaflow-notch-\(UUID().uuidString.lowercased())")
        conversations.append(conversation)
        selectedConversationID = conversation.id
        isConversationPickerPresented = false
        inputText = ""
        persistConversations()
        notifyContentChange(.immediate)
        let elapsedMs = (CFAbsoluteTimeGetCurrent() - startedAt) * 1_000
        Self.navigationLogger.notice(
            "conversation created id=\(conversation.id, privacy: .public) conversations=\(self.conversations.count) height=\(self.expandedHeight, format: .fixed(precision: 1)) elapsed_ms=\(elapsedMs, format: .fixed(precision: 1))"
        )
        return conversation.id
    }

    func selectConversation(_ id: String) {
        let startedAt = CFAbsoluteTimeGetCurrent()
        let conversation = conversation(withID: id)
        let pickerWasPresented = isConversationPickerPresented
        isConversationPickerPresented = false
        guard selectedConversationID != id else {
            if pickerWasPresented { notifyContentChange(.immediate) }
            return
        }
        selectedConversationID = id
        inputText = ""
        notifyContentChange(.immediate)
        let elapsedMs = (CFAbsoluteTimeGetCurrent() - startedAt) * 1_000
        Self.navigationLogger.notice(
            "conversation selected id=\(id, privacy: .public) messages=\(conversation.messages.count) height=\(self.expandedHeight, format: .fixed(precision: 1)) elapsed_ms=\(elapsedMs, format: .fixed(precision: 1))"
        )
    }

    func open() {
        presentation = .expanded
        onWillOpen?()
    }

    func toggleConversationPicker() {
        isConversationPickerPresented.toggle()
        notifyContentChange(.immediate)
    }

    func dock() {
        isConversationPickerPresented = false
        presentation = .docked
    }

    func toggleVoice() {
        if phase == .listening || phase == .preparingVoice {
            onStopVoice?()
        } else if !isSending {
            onStartVoice?()
        }
    }

    func prepareConversationForVoice() -> String {
        if selectedConversation.isSending { return newConversation() }
        return selectedConversationID
    }

    func submitText(_ text: String? = nil) {
        let command = (text ?? inputText).trimmingCharacters(in: .whitespacesAndNewlines)
        let conversation = selectedConversation
        guard !command.isEmpty, !conversation.isSending else { return }
        inputText = ""
        conversation.messages.append(MetaflowNotchMessage(role: .user, text: command, isError: false))
        setTitleIfNeeded(conversation, prompt: command)
        touch(conversation)
        beginWorking(conversationID: conversation.id)
        onSubmitText?(conversation.id, command)
    }

    func beginPreparingVoice(context: String?, conversationID: String? = nil) {
        let conversation = targetConversation(conversationID)
        conversation.resultTitle = "Voice"
        conversation.detail = context ?? "Connecting to Doubao"
        conversation.phase = .preparingVoice
        conversation.isSending = true
        touch(conversation)
        presentation = .docked
    }

    func beginListening(context: String?, conversationID: String? = nil) {
        let conversation = targetConversation(conversationID)
        conversation.resultTitle = "Voice"
        conversation.detail = context ?? "Listening"
        conversation.phase = .listening
        conversation.isSending = true
        touch(conversation)
        presentation = .docked
    }

    func beginTranscribing(conversationID: String? = nil) {
        let conversation = targetConversation(conversationID)
        conversation.detail = "Doubao is finalizing the utterance"
        conversation.phase = .transcribing
        conversation.isSending = true
        touch(conversation)
    }

    func recordTranscript(_ transcript: String, conversationID: String? = nil) {
        let value = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        let conversation = targetConversation(conversationID)
        if conversation.messages.last?.role != .user || conversation.messages.last?.text != value {
            conversation.messages.append(MetaflowNotchMessage(role: .user, text: value, isError: false))
        }
        setTitleIfNeeded(conversation, prompt: value)
        touch(conversation)
    }

    func beginWorking(_ message: String = "Metaflow is working", conversationID: String? = nil) {
        let conversation = targetConversation(conversationID)
        resetResponseState(conversation)
        conversation.toolActivities = []
        conversation.detail = message
        conversation.phase = .working
        conversation.isSending = true
        touch(conversation)
    }

    func showDelivery(_ card: AmbientDeliveryCard) {
        let conversation = selectedConversation
        conversation.availableActions = Set(card.actions)
        switch card.phase {
        case "accepted", "progress":
            beginWorking(conversationID: conversation.id)
        case "failure":
            conversation.phase = .error
            conversation.isSending = false
            presentation = .expanded
        case "result":
            conversation.phase = .done
            conversation.isSending = false
            presentation = .expanded
        default:
            fail("Unsupported Delivery phase: \(card.phase)")
        }
        touch(conversation)
    }

    func complete(title: String = "Result", text: String, conversationID: String? = nil) {
        let conversation = targetConversation(conversationID)
        cancelResponseTasks(conversation)
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        conversation.resultTitle = title
        conversation.resultText = value
        if let streamingMessageID = conversation.streamingMessageID,
           let index = conversation.messages.firstIndex(where: { $0.id == streamingMessageID }) {
            conversation.messages[index].text = value
        } else if !value.isEmpty {
            conversation.messages.append(MetaflowNotchMessage(role: .assistant, text: value, isError: false))
        }
        conversation.streamingMessageID = nil
        conversation.bufferedResponse = ""
        conversation.isToolMode = false
        conversation.detail = "Ready"
        conversation.phase = .done
        conversation.isSending = false
        touch(conversation)
        if conversation.id == selectedConversationID { presentation = .expanded }
    }

    func appendResponseDelta(_ delta: String, conversationID: String? = nil) {
        guard !delta.isEmpty else { return }
        let conversation = targetConversation(conversationID)
        conversation.bufferedResponse += delta
        guard !conversation.isToolMode else { return }
        if conversation.streamingMessageID == nil {
            scheduleStreamReveal(conversation)
            return
        }
        scheduleStreamRender(conversation)
    }

    func recordToolActivity(_ event: AmbientToolActivityEvent, conversationID: String? = nil) {
        guard !event.toolCallID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            preconditionFailure("Tool activity requires a tool call id")
        }
        let conversation = targetConversation(conversationID)
        enterToolMode(conversation)
        if let index = conversation.toolActivities.firstIndex(where: { $0.id == event.toolCallID }) {
            conversation.toolActivities[index].merge(event)
        } else {
            conversation.toolActivities.append(MetaflowToolActivity(event))
        }
        conversation.detail = activeToolDetail(in: conversation)
        conversation.phase = .working
        conversation.isSending = true
        touch(conversation, persist: false)
    }

    func fail(_ message: String, conversationID: String? = nil) {
        let conversation = targetConversation(conversationID)
        cancelResponseTasks(conversation)
        removeProvisionalResponse(conversation)
        conversation.bufferedResponse = ""
        conversation.isToolMode = false
        conversation.streamingMessageID = nil
        conversation.resultTitle = "Error"
        conversation.resultText = message
        conversation.messages.append(MetaflowNotchMessage(role: .assistant, text: message, isError: true))
        conversation.detail = message
        conversation.phase = .error
        conversation.isSending = false
        touch(conversation)
        if conversation.id == selectedConversationID { presentation = .expanded }
    }

    func markReady(_ message: String, conversationID: String? = nil) {
        let conversation = targetConversation(conversationID)
        conversation.detail = message
        if !conversation.isSending && conversation.phase != .done && conversation.phase != .error {
            conversation.phase = .idle
        }
        notifyContentChange()
    }

    func reset() {
        let conversation = selectedConversation
        conversation.phase = .idle
        inputText = ""
        conversation.resultText = ""
        conversation.resultTitle = "Metaflow"
        conversation.detail = "Ready"
        conversation.messages = []
        conversation.availableActions = []
        conversation.toolActivities = []
        conversation.isSending = false
        resetResponseState(conversation)
        touch(conversation)
        presentation = .docked
    }

    func copyResult() { onCopy?() }
    func perform(_ action: String) { onAction?(action) }

    func conversation(withID id: String) -> MetaflowNotchConversation {
        guard let conversation = conversations.first(where: { $0.id == id }) else {
            preconditionFailure("Unknown Metaflow conversation id: \(id)")
        }
        return conversation
    }

    private func targetConversation(_ id: String?) -> MetaflowNotchConversation {
        id.map(conversation(withID:)) ?? selectedConversation
    }

    private func scheduleStreamReveal(_ conversation: MetaflowNotchConversation) {
        guard conversation.streamRevealTask == nil else { return }
        conversation.streamRevealTask = Task { @MainActor [weak self, weak conversation] in
            guard let self, let conversation else { return }
            try? await Task.sleep(nanoseconds: streamRevealDelayNanoseconds)
            guard !Task.isCancelled else { return }
            revealBufferedResponse(conversation)
        }
    }

    private func revealBufferedResponse(_ conversation: MetaflowNotchConversation) {
        conversation.streamRevealTask = nil
        guard !conversation.isToolMode, !conversation.bufferedResponse.isEmpty else { return }
        let id = UUID()
        conversation.streamingMessageID = id
        conversation.messages.append(MetaflowNotchMessage(id: id, role: .assistant, text: conversation.bufferedResponse, isError: false))
        conversation.resultText = conversation.bufferedResponse
        conversation.detail = "Answering"
        conversation.phase = .working
        conversation.isSending = true
        notifyContentChange()
    }

    private func scheduleStreamRender(_ conversation: MetaflowNotchConversation) {
        guard conversation.streamRenderTask == nil else { return }
        conversation.streamRenderTask = Task { @MainActor [weak self, weak conversation] in
            guard let self, let conversation else { return }
            try? await Task.sleep(nanoseconds: streamRenderIntervalNanoseconds)
            guard !Task.isCancelled else { return }
            flushBufferedResponse(conversation)
        }
    }

    private func flushBufferedResponse(_ conversation: MetaflowNotchConversation) {
        conversation.streamRenderTask = nil
        guard !conversation.isToolMode,
              let streamingMessageID = conversation.streamingMessageID,
              let index = conversation.messages.firstIndex(where: { $0.id == streamingMessageID }) else { return }
        let text = conversation.bufferedResponse
        guard conversation.messages[index].text != text else { return }
        conversation.messages[index].text = text
        conversation.resultText = text
        notifyContentChange()
    }

    private func enterToolMode(_ conversation: MetaflowNotchConversation) {
        guard !conversation.isToolMode else { return }
        conversation.isToolMode = true
        cancelResponseTasks(conversation)
        removeProvisionalResponse(conversation)
        conversation.resultText = ""
    }

    private func removeProvisionalResponse(_ conversation: MetaflowNotchConversation) {
        guard let streamingMessageID = conversation.streamingMessageID else { return }
        conversation.messages.removeAll { $0.id == streamingMessageID }
        conversation.streamingMessageID = nil
    }

    private func resetResponseState(_ conversation: MetaflowNotchConversation) {
        cancelResponseTasks(conversation)
        conversation.bufferedResponse = ""
        conversation.isToolMode = false
        conversation.streamingMessageID = nil
    }

    private func cancelResponseTasks(_ conversation: MetaflowNotchConversation) {
        conversation.streamRevealTask?.cancel()
        conversation.streamRevealTask = nil
        conversation.streamRenderTask?.cancel()
        conversation.streamRenderTask = nil
    }

    private func activeToolDetail(in conversation: MetaflowNotchConversation) -> String {
        guard let latest = conversation.toolActivities.last else { return "Using tools" }
        return latest.title ?? latest.toolName ?? latest.kind ?? "Using tools"
    }

    private func hasStreamingText(in conversation: MetaflowNotchConversation) -> Bool {
        guard let streamingMessageID = conversation.streamingMessageID,
              let message = conversation.messages.first(where: { $0.id == streamingMessageID }) else { return false }
        return !message.text.isEmpty
    }

    private func setTitleIfNeeded(_ conversation: MetaflowNotchConversation, prompt: String) {
        guard conversation.title == "New conversation" else { return }
        let normalized = prompt.replacingOccurrences(of: "\n", with: " ")
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        conversation.title = normalized.count > 38 ? "\(normalized.prefix(38))..." : normalized
    }

    private func touch(_ conversation: MetaflowNotchConversation, persist: Bool = true) {
        conversation.updatedAt = Date()
        if persist { persistConversations() }
        notifyContentChange()
    }

    private func persistConversations() {
        guard let conversationStore else { return }
        do {
            try conversationStore.save(conversations.map(\.snapshot))
        } catch {
            preconditionFailure("Could not persist Metaflow conversations: \(error.localizedDescription)")
        }
    }

    private func notifyContentChange(_ change: MetaflowContentChange = .throttled) {
        onContentChange?(change)
    }
}
