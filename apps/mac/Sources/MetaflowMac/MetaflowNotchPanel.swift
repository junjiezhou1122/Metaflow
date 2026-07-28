import AppKit
import MarkdownUI
import Observation
import OSLog
import SwiftUI

@MainActor
@Observable
private final class MetaflowNotchRenderState {
    var presentation: MetaflowNotchPresentation

    init(presentation: MetaflowNotchPresentation) {
        self.presentation = presentation
    }
}

@MainActor
final class MetaflowNotchPanelController: NSObject {
    private static let logger = Logger(
        subsystem: "com.metaflow.mac.visible",
        category: "NotchPresentation"
    )

    private let panel: NSPanel
    private let model: MetaflowNotchModel
    private let renderState: MetaflowNotchRenderState
    private let hostingView: NSHostingView<MetaflowNotchRoot>
    private var contentResizeWorkItem: DispatchWorkItem?

    init(model: MetaflowNotchModel) {
        self.model = model
        renderState = MetaflowNotchRenderState(presentation: model.presentation)
        let size = NSScreen.main?.metaflowNotchSize(for: model) ?? CGSize(width: 320, height: 44)
        panel = MetaflowNotchPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )
        hostingView = NSHostingView(
            rootView: MetaflowNotchRoot(model: model, renderState: renderState)
        )
        super.init()
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = false
        hostingView.wantsLayer = true
        panel.contentView = hostingView
        model.onPresentationChange = { [weak self] presentation in
            self?.transition(to: presentation)
        }
        model.onContentChange = { [weak self] change in
            self?.contentDidChange(change)
        }
        applyCurrentFrame(display: false)
        panel.orderFrontRegardless()
    }

    func show() {
        applyCurrentFrame(display: false)
        panel.orderFrontRegardless()
    }

    private func transition(to presentation: MetaflowNotchPresentation) {
        contentResizeWorkItem?.cancel()
        contentResizeWorkItem = nil
        let startedAt = CFAbsoluteTimeGetCurrent()
        renderState.presentation = presentation
        applyCurrentFrame(display: true)
        let elapsedMs = (CFAbsoluteTimeGetCurrent() - startedAt) * 1_000
        Self.logger.notice(
            "presentation committed target=\(presentation == .expanded ? "expanded" : "docked", privacy: .public) elapsed_ms=\(elapsedMs, format: .fixed(precision: 1))"
        )
    }

    private func contentDidChange(_ change: MetaflowContentChange) {
        guard model.presentation == .expanded else { return }
        switch change {
        case .immediate:
            contentResizeWorkItem?.cancel()
            contentResizeWorkItem = nil
            scheduleContentResize(after: 0, reason: "immediate")
        case .throttled:
            scheduleContentResize(after: 0.033, reason: "streaming")
        }
    }

    private func scheduleContentResize(after delay: TimeInterval, reason: String) {
        guard contentResizeWorkItem == nil else { return }
        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            contentResizeWorkItem = nil
            let startedAt = CFAbsoluteTimeGetCurrent()
            applyCurrentFrame(display: false)
            let elapsedMs = (CFAbsoluteTimeGetCurrent() - startedAt) * 1_000
            Self.logger.notice(
                "content resize committed reason=\(reason, privacy: .public) height=\(self.panel.frame.height, format: .fixed(precision: 1)) elapsed_ms=\(elapsedMs, format: .fixed(precision: 1))"
            )
        }
        contentResizeWorkItem = workItem
        if delay == 0 {
            DispatchQueue.main.async(execute: workItem)
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
        }
    }

    private func applyCurrentFrame(display: Bool) {
        guard let next = targetFrame(), !framesMatch(panel.frame, next) else { return }
        panel.setFrame(next, display: display)
    }

    private func targetFrame() -> NSRect? {
        guard let screen = panel.screen ?? NSScreen.main else { return nil }
        let size = screen.metaflowNotchSize(for: model)
        let frame = screen.frame
        return NSRect(
            x: frame.midX - size.width / 2,
            y: frame.maxY - size.height,
            width: size.width,
            height: size.height
        )
    }

    private func framesMatch(_ lhs: NSRect, _ rhs: NSRect) -> Bool {
        abs(lhs.origin.x - rhs.origin.x) < 0.5
            && abs(lhs.origin.y - rhs.origin.y) < 0.5
            && abs(lhs.width - rhs.width) < 0.5
            && abs(lhs.height - rhs.height) < 0.5
    }

}

private final class MetaflowNotchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

private extension NSScreen {
    var metaflowClosedNotchSize: CGSize {
        let menuHeight = max(28, frame.maxY - visibleFrame.maxY)
        if let left = auxiliaryTopLeftArea?.width, let right = auxiliaryTopRightArea?.width {
            let width = max(180, min(430, frame.width - left - right + 4))
            let height = max(34, min(54, safeAreaInsets.top > 0 ? safeAreaInsets.top : menuHeight))
            return CGSize(width: width, height: height)
        }
        return CGSize(width: 320, height: min(46, menuHeight))
    }

    @MainActor
    func metaflowNotchSize(for model: MetaflowNotchModel) -> CGSize {
        let closed = metaflowClosedNotchSize
        switch model.presentation {
        case .docked:
            return closed
        case .expanded:
            return CGSize(
                width: max(closed.width + 170, min(560, frame.width * 0.36)),
                height: model.expandedHeight
            )
        }
    }
}

private struct MetaflowBottomRoundedRectangle: Shape {
    let radius: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - radius))
        path.addArc(
            center: CGPoint(x: rect.maxX - radius, y: rect.maxY - radius),
            radius: radius,
            startAngle: .degrees(0),
            endAngle: .degrees(90),
            clockwise: false
        )
        path.addLine(to: CGPoint(x: rect.minX + radius, y: rect.maxY))
        path.addArc(
            center: CGPoint(x: rect.minX + radius, y: rect.maxY - radius),
            radius: radius,
            startAngle: .degrees(90),
            endAngle: .degrees(180),
            clockwise: false
        )
        path.closeSubpath()
        return path
    }
}

private struct MetaflowNotchRoot: View {
    let model: MetaflowNotchModel
    let renderState: MetaflowNotchRenderState

    var body: some View {
        GeometryReader { proxy in
            Group {
                if renderState.presentation == .docked {
                    MetaflowDockedNotch(model: model)
                } else {
                    MetaflowExpandedNotch(model: model)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .environment(\.colorScheme, .dark)
    }
}

private struct MetaflowDockedNotch: View {
    let model: MetaflowNotchModel

    var body: some View {
        Button {
            model.open()
        } label: {
            VStack(spacing: 0) {
                HStack(spacing: 11) {
                    MetaflowMark(phase: model.phase)
                        .frame(width: 27, height: 27)

                    if model.showsActivity {
                        MetaflowMiniWaveform(phase: model.phase)
                            .frame(width: 42, height: 22)
                    }

                    Text(model.statusLine)
                        .font(.system(size: 14, weight: .semibold))
                        .lineLimit(1)

                    Spacer(minLength: 6)

                    Image(systemName: model.showsActivity ? "ellipsis" : "chevron.down")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.72))
                }
                .padding(.horizontal, 14)
                .padding(.top, 5)
                .padding(.bottom, 9)
                Spacer(minLength: 0)
            }
            .background(.black, in: MetaflowBottomRoundedRectangle(radius: 16))
            .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
        .help("Open Metaflow")
    }
}

private struct MetaflowExpandedNotch: View {
    @Bindable var model: MetaflowNotchModel
    @FocusState private var commandFocused: Bool
    @State private var expandedHistoryConversationIDs: Set<String> = []

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().opacity(0.35)
            GeometryReader { scrollGeometry in
                ScrollViewReader { scrollProxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            if model.messages.isEmpty && model.phase == .idle {
                                quickActions
                            }
                            conversation(width: max(0, scrollGeometry.size.width - 28))
                        }
                        .padding(.horizontal, 14)
                        .padding(.top, 12)
                        .padding(.bottom, 8)
                        .frame(width: scrollGeometry.size.width, alignment: .topLeading)
                    }
                    .defaultScrollAnchor(.top)
                    .task(id: currentTurnAnchor) {
                        guard let messageID = currentTurnAnchor.messageID else { return }
                        try? await Task.sleep(for: .milliseconds(50))
                        guard !Task.isCancelled else { return }
                        scrollProxy.scrollTo(messageID, anchor: .top)
                    }
                }
            }
            Divider().opacity(0.24)
            VStack(spacing: 7) {
                if let selectionContext = model.selectionContext {
                    MetaflowSelectionContextRow(context: selectionContext)
                        .transition(.opacity)
                }
                composer
            }
                .padding(.horizontal, 14)
                .padding(.top, 10)
                .padding(.bottom, 12)
                .background(.black.opacity(0.16))
        }
        .background(Color(red: 0.035, green: 0.039, blue: 0.047), in: MetaflowBottomRoundedRectangle(radius: 22))
        .foregroundStyle(.white)
        .overlay {
            MetaflowBottomRoundedRectangle(radius: 22)
                .stroke(.white.opacity(0.12), lineWidth: 1)
        }
        .overlay(alignment: .topLeading) {
            if model.isConversationPickerPresented {
                MetaflowConversationPicker(
                    model: model,
                    onSelect: selectConversation,
                    onNew: startConversation
                )
                .padding(.top, 54)
                .padding(.leading, 14)
                .shadow(color: .black.opacity(0.45), radius: 18, y: 10)
                .zIndex(20)
            }
        }
        .onAppear { commandFocused = model.phase == .idle }
        .onChange(of: currentTurnAnchor) {
            expandedHistoryConversationIDs.remove(model.selectedConversationID)
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            MetaflowMark(phase: model.phase)
                .frame(width: 26, height: 26)
            Button {
                model.toggleConversationPicker()
            } label: {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text(model.selectedConversation.title)
                            .font(.system(size: 15, weight: .semibold))
                            .lineLimit(1)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.white.opacity(0.46))
                    }
                    Text(model.detail)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.white.opacity(0.64))
                        .lineLimit(1)
                }
            }
            .buttonStyle(.plain)
            .help("Choose conversation")
            Spacer()
            Button {
                model.newConversation()
                commandFocused = true
            } label: {
                Image(systemName: "square.and.pencil")
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.borderless)
            .help("New conversation")

            Button {
                model.toggleVoice()
            } label: {
                Image(systemName: model.phase == .listening ? "stop.fill" : "mic.fill")
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.borderless)
            .disabled(model.isSending && model.phase != .listening && model.phase != .preparingVoice)
            .help(model.phase == .listening ? "Stop voice" : "Start voice")

            Button {
                model.dock()
            } label: {
                Image(systemName: "chevron.up")
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.borderless)
            .help("Dock near the notch")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var quickActions: some View {
        HStack(spacing: 8) {
            MetaflowQuickAction(icon: "text.alignleft", label: "Summarize") {
                model.submitText("Summarize the current screen in five useful bullets.")
            }
            MetaflowQuickAction(icon: "list.bullet.clipboard", label: "Extract") {
                model.submitText("Extract decisions, requirements, and next actions from the current screen.")
            }
            MetaflowQuickAction(icon: "wand.and.stars", label: "Rewrite") {
                model.submitText("Rewrite the selected or visible text to be clearer and more concise.")
            }
        }
    }

    @ViewBuilder
    private func conversation(width: CGFloat) -> some View {
        if model.messages.isEmpty {
            MetaflowStatusRow(model: model)
                .frame(width: width, alignment: .leading)
        } else {
            LazyVStack(alignment: .leading, spacing: 9) {
                if !isEarlierHistoryExpanded && model.earlierMessageCount > 0 {
                    Button {
                        expandedHistoryConversationIDs.insert(model.selectedConversationID)
                    } label: {
                        HStack(spacing: 7) {
                            Image(systemName: "clock.arrow.circlepath")
                            Text("Show \(model.earlierMessageCount) earlier messages")
                        }
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.white.opacity(0.58))
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.plain)
                }

                ForEach(visibleMessages) { message in
                    MetaflowMessageRow(message: message, model: model, availableWidth: width)
                        .id(message.id)
                    if message.id == latestUserMessageID, !model.toolActivities.isEmpty {
                        MetaflowToolTimeline(activities: model.toolActivities)
                            .frame(width: width, alignment: .leading)
                    }
                }
                if model.showsActivity && model.toolActivities.isEmpty {
                    MetaflowStatusRow(model: model)
                }
            }
            .frame(width: width, alignment: .leading)
        }
    }

    private var isEarlierHistoryExpanded: Bool {
        expandedHistoryConversationIDs.contains(model.selectedConversationID)
    }

    private var visibleMessages: [MetaflowNotchMessage] {
        isEarlierHistoryExpanded ? model.messages : model.currentTurnMessages
    }

    private var latestUserMessageID: UUID? {
        model.messages.last(where: { $0.role == .user })?.id
    }

    private var currentTurnAnchor: MetaflowTurnScrollAnchor {
        MetaflowTurnScrollAnchor(
            conversationID: model.selectedConversationID,
            messageID: latestUserMessageID
        )
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(
                "",
                text: $model.inputText,
                prompt: Text("Message Metaflow").foregroundStyle(.white.opacity(0.38)),
                axis: .vertical
            )
                .textFieldStyle(.plain)
                .foregroundStyle(.white.opacity(0.96))
                .tint(.cyan)
                .lineLimit(1...4)
                .focused($commandFocused)
                .padding(.vertical, 12)
                .padding(.leading, 13)
                .onSubmit { model.submitText() }

            Button {
                model.submitText()
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 14, weight: .bold))
                    .frame(width: 32, height: 32)
                    .background(Color(red: 0.18, green: 0.72, blue: 0.88), in: Circle())
                    .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
            .help("Send")
            .disabled(model.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSending)
            .opacity(model.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSending ? 0.34 : 1)
            .frame(width: 40, height: 40)
            .padding(.trailing, 4)
            .padding(.bottom, 2)
        }
        .background(.white.opacity(commandFocused ? 0.15 : 0.11), in: .rect(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(commandFocused ? .cyan.opacity(0.78) : .white.opacity(0.18), lineWidth: 1.25)
        }
    }

    private func selectConversation(_ id: String) {
        model.selectConversation(id)
        commandFocused = true
    }

    private func startConversation() {
        model.newConversation()
        commandFocused = true
    }

}

private struct MetaflowSelectionContextRow: View {
    let context: MetaflowSelectionContext

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "text.quote")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.cyan.opacity(0.88))
                .frame(width: 18, height: 18)

            Text(context.preview)
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.78))
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 6)

            Text(context.appName)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.white.opacity(0.44))
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .frame(height: 28)
        .background(.white.opacity(0.07), in: .rect(cornerRadius: 7))
        .overlay {
            RoundedRectangle(cornerRadius: 7)
                .stroke(.white.opacity(0.1), lineWidth: 1)
        }
        .help("Selected text from \(context.appName)")
    }
}

private struct MetaflowTurnScrollAnchor: Equatable {
    let conversationID: String
    let messageID: UUID?
}

private struct MetaflowConversationPicker: View {
    let model: MetaflowNotchModel
    let onSelect: (String) -> Void
    let onNew: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Conversations")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                Button {
                    onNew()
                } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(.plain)
                .help("New conversation")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)

            Divider().opacity(0.45)

            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(model.sortedConversations) { conversation in
                        Button {
                            onSelect(conversation.id)
                        } label: {
                            MetaflowConversationRow(
                                conversation: conversation,
                                updatedLabel: conversationUpdatedLabel(conversation.updatedAt),
                                isSelected: conversation.id == model.selectedConversationID
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(6)
            }
            .frame(maxHeight: 310)
        }
        .frame(width: 330)
        .background(Color(red: 0.075, green: 0.082, blue: 0.095))
        .environment(\.colorScheme, .dark)
    }
}

private struct MetaflowConversationRow: View {
    let conversation: MetaflowNotchConversation
    let updatedLabel: String
    let isSelected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            statusIndicator
                .frame(width: 16, height: 20)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(conversation.title)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white.opacity(0.94))
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Text(updatedLabel)
                        .font(.system(size: 10, weight: .regular))
                        .foregroundStyle(.white.opacity(0.38))
                        .lineLimit(1)
                }
                Text(conversation.preview)
                    .font(.system(size: 11, weight: .regular))
                    .foregroundStyle(.white.opacity(0.52))
                    .lineLimit(1)
            }

            if isSelected {
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.cyan)
                    .frame(width: 14, height: 20)
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isSelected ? .white.opacity(0.1) : .clear, in: .rect(cornerRadius: 7))
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var statusIndicator: some View {
        if conversation.isSending {
            ProgressView()
                .controlSize(.mini)
                .tint(.cyan)
        } else {
            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
                .padding(.top, 6)
        }
    }

    private var statusColor: Color {
        switch conversation.phase {
        case .error: .red
        case .done: .green.opacity(0.8)
        default: .white.opacity(0.28)
        }
    }
}

private func conversationUpdatedLabel(_ date: Date, now: Date = Date()) -> String {
    let seconds = max(0, Int(now.timeIntervalSince(date)))
    if seconds < 60 { return "Now" }
    if seconds < 3_600 { return "\(seconds / 60)m" }
    if seconds < 86_400 { return "\(seconds / 3_600)h" }
    if seconds < 604_800 { return "\(seconds / 86_400)d" }
    return date.formatted(.dateTime.month(.abbreviated).day())
}

private struct MetaflowToolTimeline: View {
    let activities: [MetaflowToolActivity]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(activities) { activity in
                MetaflowToolActivityRow(activity: activity)
            }
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Agent tool activity")
    }
}

private struct MetaflowToolActivityRow: View {
    let activity: MetaflowToolActivity

    var body: some View {
        HStack(spacing: 9) {
            statusIcon
                .frame(width: 18, height: 18)

            VStack(alignment: .leading, spacing: 2) {
                Text(activity.title ?? activity.toolName ?? activity.kind ?? "Tool")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.84))
                    .lineLimit(2)

                if let metadata = metadataText {
                    Text(metadata)
                        .font(.system(size: 11, weight: .regular, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.42))
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 8)

            Text(statusLabel)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(statusColor.opacity(0.82))
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var statusIcon: some View {
        if isRunning {
            ProgressView()
                .controlSize(.small)
                .tint(.cyan)
        } else {
            Image(systemName: statusSymbol)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(statusColor)
        }
    }

    private var normalizedStatus: String {
        activity.status?.lowercased() ?? "running"
    }

    private var isRunning: Bool {
        ["pending", "in_progress", "running", "background"].contains(normalizedStatus)
    }

    private var statusLabel: String {
        switch normalizedStatus {
        case "completed": "Done"
        case "failed": "Failed"
        default: "Running"
        }
    }

    private var statusSymbol: String {
        normalizedStatus == "failed" ? "xmark.circle.fill" : "checkmark.circle.fill"
    }

    private var statusColor: Color {
        switch normalizedStatus {
        case "completed": .green
        case "failed": .red
        default: .cyan
        }
    }

    private var metadataText: String? {
        let primary = activity.title ?? activity.toolName ?? activity.kind
        let values = [activity.toolName, activity.kind]
            .compactMap { $0 }
            .filter { $0 != primary }
        return values.isEmpty ? nil : values.joined(separator: " · ")
    }
}

private struct MetaflowQuickAction: View {
    let icon: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 7) {
                Image(systemName: icon)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(.cyan)
                Text(label)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.88))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(.white.opacity(0.08), in: .rect(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }
}

private struct MetaflowStatusRow: View {
    let model: MetaflowNotchModel

    var body: some View {
        HStack(spacing: 9) {
            if model.showsActivity {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: model.phase == .error ? "exclamationmark.triangle" : "sparkles")
            }
            Text(statusText)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(model.phase == .error ? .red.opacity(0.92) : .white.opacity(0.72))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.06), in: .rect(cornerRadius: 8))
    }

    private var statusText: String {
        switch model.phase {
        case .idle: "Ask Metaflow or use \(model.shortcutLabel) to speak."
        case .preparingVoice: "Connecting to Doubao..."
        case .listening: "Listening. Release the shortcut to send."
        case .transcribing: "Transcribing your voice..."
        case .working: "Metaflow is working"
        case .needsApproval: "Approval needed."
        case .done: model.resultText
        case .error: model.resultText
        }
    }
}

private struct MetaflowMessageRow: View {
    let message: MetaflowNotchMessage
    let model: MetaflowNotchModel
    let availableWidth: CGFloat

    var body: some View {
        Group {
            if message.role == .user {
                ViewThatFits(in: .horizontal) {
                    userBubble
                        .fixedSize(horizontal: true, vertical: true)
                    userBubble
                        .frame(width: min(430, availableWidth * 0.82), alignment: .leading)
                }
            } else {
                assistantContent
                    .frame(width: availableWidth, alignment: .leading)
            }
        }
        .frame(width: availableWidth, alignment: message.role == .user ? .trailing : .leading)
    }

    private var userBubble: some View {
        Text(message.text)
            .font(.system(size: 14, weight: .regular))
            .foregroundStyle(.white.opacity(0.94))
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .padding(.horizontal, 13)
            .padding(.vertical, 10)
            .background(.white.opacity(0.14), in: .rect(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .stroke(.white.opacity(0.1), lineWidth: 1)
            }
    }

    private var assistantContent: some View {
        ZStack(alignment: .topTrailing) {
            MetaflowMarkdownText(message.markdownContent)
                .foregroundStyle(message.isError ? .red.opacity(0.95) : .white.opacity(0.92))
                .textSelection(.enabled)
                .padding(.trailing, message.isError ? 0 : 30)

            if !message.isError && !message.text.isEmpty {
                Button { model.copyResult() } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.white.opacity(0.48))
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(.plain)
                .help("Copy answer")
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, message.isError ? 10 : 0)
        .background {
            if message.isError {
                RoundedRectangle(cornerRadius: 8)
                    .fill(.red.opacity(0.12))
            }
        }
        .overlay {
            if message.isError {
                RoundedRectangle(cornerRadius: 8)
                    .stroke(.red.opacity(0.3), lineWidth: 1)
            }
        }
    }
}

struct MetaflowMarkdownText: View {
    let content: MarkdownContent

    init(_ text: String) {
        content = MarkdownContent(text)
    }

    init(_ content: MarkdownContent) {
        self.content = content
    }

    var body: some View {
        Markdown(content)
            .markdownTheme(.metaflowConversation)
            .tint(.cyan)
            .environment(\.colorScheme, .dark)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private extension Theme {
    @MainActor
    static var metaflowConversation: Theme {
        Theme()
        .text {
            ForegroundColor(.white.opacity(0.92))
            FontSize(15)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.86))
            BackgroundColor(.white.opacity(0.09))
        }
        .strong { FontWeight(.semibold) }
        .link { ForegroundColor(.cyan) }
        .heading1 { configuration in
            configuration.label
                .markdownMargin(top: 10, bottom: 8)
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(1.35))
                }
        }
        .heading2 { configuration in
            configuration.label
                .markdownMargin(top: 10, bottom: 7)
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(1.18))
                }
        }
        .heading3 { configuration in
            configuration.label
                .markdownMargin(top: 8, bottom: 6)
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(1.06))
                }
        }
        .heading4 { configuration in
            configuration.label
                .markdownMargin(top: 8, bottom: 6)
                .markdownTextStyle { FontWeight(.semibold) }
        }
        .heading5 { configuration in
            configuration.label
                .markdownMargin(top: 8, bottom: 6)
                .markdownTextStyle { FontWeight(.semibold) }
        }
        .heading6 { configuration in
            configuration.label
                .markdownMargin(top: 8, bottom: 6)
                .markdownTextStyle {
                    FontWeight(.semibold)
                    ForegroundColor(.white.opacity(0.65))
                }
        }
        .paragraph { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .relativeLineSpacing(.em(0.22))
                .markdownMargin(top: 0, bottom: 10)
        }
        .blockquote { configuration in
            HStack(spacing: 10) {
                Rectangle()
                    .fill(.white.opacity(0.22))
                    .frame(width: 2)
                configuration.label
                    .markdownTextStyle { ForegroundColor(.white.opacity(0.68)) }
            }
            .fixedSize(horizontal: false, vertical: true)
            .markdownMargin(top: 2, bottom: 10)
        }
        .codeBlock { configuration in
            VStack(spacing: 0) {
                HStack {
                    Text(configuration.language ?? "text")
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.48))
                    Spacer()
                    Button {
                        copyMarkdownText(configuration.content)
                    } label: {
                        Image(systemName: "doc.on.doc")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.white.opacity(0.5))
                    }
                    .buttonStyle(.plain)
                    .help("Copy code")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)

                Divider().opacity(0.22)

                ScrollView(.horizontal) {
                    configuration.label
                        .fixedSize(horizontal: false, vertical: true)
                        .relativeLineSpacing(.em(0.2))
                        .markdownTextStyle {
                            FontFamilyVariant(.monospaced)
                            FontSize(.em(0.86))
                        }
                        .padding(12)
                }
            }
            .background(.white.opacity(0.065))
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .overlay {
                RoundedRectangle(cornerRadius: 7)
                    .stroke(.white.opacity(0.09), lineWidth: 1)
            }
            .markdownMargin(top: 2, bottom: 10)
        }
        .listItem { configuration in
            configuration.label
                .markdownMargin(top: .em(0.16))
        }
        .thematicBreak {
            Divider()
                .overlay(.white.opacity(0.14))
                .markdownMargin(top: 12, bottom: 12)
        }
    }
}

private func copyMarkdownText(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}

private struct MetaflowMiniWaveform: View {
    let phase: MetaflowNotchPhase

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.12)) { timeline in
            let time = timeline.date.timeIntervalSinceReferenceDate
            HStack(alignment: .center, spacing: 3) {
                ForEach(0..<5, id: \.self) { index in
                    Capsule()
                        .fill(waveColor.opacity(0.95))
                        .frame(width: 3, height: barHeight(index: index, time: time))
                }
            }
        }
        .accessibilityHidden(true)
    }

    private func barHeight(index: Int, time: TimeInterval) -> CGFloat {
        let wave = sin(time * 6.2 + Double(index) * 0.72)
        return 7 + CGFloat((wave + 1) / 2) * 13
    }

    private var waveColor: Color {
        switch phase {
        case .listening: .cyan
        case .transcribing: .purple
        case .working: .cyan
        default: .white
        }
    }
}

private struct MetaflowMark: View {
    let phase: MetaflowNotchPhase

    var body: some View {
        ZStack {
            Circle().fill(markColor.opacity(0.18))
            Image(systemName: markSymbol)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(markColor)
        }
        .accessibilityLabel("Metaflow \(phase.rawValue)")
    }

    private var markSymbol: String {
        switch phase {
        case .idle: "sparkles"
        case .preparingVoice: "dot.radiowaves.left.and.right"
        case .listening: "waveform"
        case .transcribing: "text.bubble"
        case .working: "arrow.triangle.branch"
        case .needsApproval: "checkmark.shield"
        case .done: "checkmark"
        case .error: "exclamationmark.triangle"
        }
    }

    private var markColor: Color {
        switch phase {
        case .idle: .white.opacity(0.74)
        case .preparingVoice, .listening: .cyan
        case .transcribing: .purple
        case .working: .cyan
        case .needsApproval: .orange
        case .done: .green
        case .error: .red
        }
    }
}
