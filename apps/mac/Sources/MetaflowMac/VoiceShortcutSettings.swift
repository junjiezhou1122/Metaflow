import AppKit
import Carbon.HIToolbox

enum AgentHarness: String, Codable, CaseIterable {
    case pi
    case claudeCodeACP = "claude_code_acp"
}

struct AgentBackendConfiguration: Codable, Equatable {
    let harness: AgentHarness
    let provider: String
    let model: String

    init(harness: AgentHarness, provider: String, model: String) {
        self.harness = harness
        self.provider = provider
        self.model = model
    }

    static let defaultValue = AgentBackendConfiguration(
        harness: .claudeCodeACP,
        provider: "",
        model: ""
    )

    private enum CodingKeys: String, CodingKey {
        case harness
        case provider
        case model
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        harness = try container.decode(AgentHarness.self, forKey: .harness)
        provider = try container.decodeIfPresent(String.self, forKey: .provider) ?? ""
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? ""
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(harness, forKey: .harness)
        if !provider.isEmpty { try container.encode(provider, forKey: .provider) }
        if !model.isEmpty { try container.encode(model, forKey: .model) }
    }

    var displayName: String {
        switch harness {
        case .pi: return "Pi · \(provider)/\(model)"
        case .claudeCodeACP: return "Claude Code ACP"
        }
    }
}

final class AgentBackendStore {
    private let defaults: UserDefaults
    private let key = "metaflow.agentBackend.v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> AgentBackendConfiguration {
        guard let data = defaults.data(forKey: key) else { return .defaultValue }
        do {
            return try JSONDecoder().decode(AgentBackendConfiguration.self, from: data)
        } catch {
            NSLog("[metaflow] agent.settings_invalid error=%@", error.localizedDescription)
            return .defaultValue
        }
    }

    func save(_ configuration: AgentBackendConfiguration) throws {
        defaults.set(try JSONEncoder().encode(configuration), forKey: key)
    }
}

@MainActor
final class VoiceShortcutSettingsController: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private var modeControl: NSSegmentedControl?
    private var recorder: VoiceShortcutRecorderView?
    private var draft = VoiceShortcutConfiguration.defaultValue
    private var harnessControl: NSPopUpButton?
    private var providerControl: NSComboBox?
    private var modelControl: NSComboBox?
    private var draftAgent = AgentBackendConfiguration.defaultValue
    private var onSave: ((VoiceShortcutConfiguration, AgentBackendConfiguration) -> Void)?

    func show(
        current: VoiceShortcutConfiguration,
        agent: AgentBackendConfiguration,
        onSave: @escaping (VoiceShortcutConfiguration, AgentBackendConfiguration) -> Void
    ) {
        if let window {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            return
        }
        draft = current
        draftAgent = agent
        self.onSave = onSave

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 410),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Metaflow Settings"
        window.isReleasedWhenClosed = false
        window.delegate = self

        let title = NSTextField(labelWithString: "Voice shortcut")
        title.font = .systemFont(ofSize: 18, weight: .semibold)
        let subtitle = NSTextField(wrappingLabelWithString: "Hold the shortcut to speak, then release it to send.")
        subtitle.font = .systemFont(ofSize: 12)
        subtitle.textColor = .secondaryLabelColor

        let mode = NSSegmentedControl(labels: ["Hold Right Option", "Custom"], trackingMode: .selectOne, target: self, action: #selector(modeChanged))
        mode.selectedSegment = current.mode == .rightOptionHold ? 0 : 1
        mode.translatesAutoresizingMaskIntoConstraints = false

        let recorder = VoiceShortcutRecorderView(frame: .zero)
        recorder.shortcut = current.mode == .keyCombination ? current : .optionSpace
        recorder.isEnabled = current.mode == .keyCombination
        recorder.onChange = { [weak self] shortcut in self?.draft = shortcut }
        recorder.translatesAutoresizingMaskIntoConstraints = false

        let separator = NSBox()
        separator.boxType = .separator
        let agentTitle = NSTextField(labelWithString: "Agent")
        agentTitle.font = .systemFont(ofSize: 18, weight: .semibold)
        let agentSubtitle = NSTextField(wrappingLabelWithString: "Choose the conversation harness and model. Pi supports any provider/model present in your Pi catalog.")
        agentSubtitle.font = .systemFont(ofSize: 12)
        agentSubtitle.textColor = .secondaryLabelColor

        let harness = NSPopUpButton()
        harness.addItems(withTitles: ["Claude Code ACP", "Pi"])
        harness.selectItem(at: agent.harness == .claudeCodeACP ? 0 : 1)
        harness.target = self
        harness.action = #selector(harnessChanged)

        let provider = NSComboBox()
        provider.stringValue = agent.provider
        provider.placeholderString = "Pi provider"

        let model = NSComboBox()
        model.stringValue = agent.model
        model.placeholderString = "Pi model"

        let agentFields = NSStackView(views: [provider, model])
        agentFields.orientation = .horizontal
        agentFields.spacing = 10
        provider.widthAnchor.constraint(equalTo: agentFields.widthAnchor, multiplier: 0.36).isActive = true

        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelPressed))
        cancel.keyEquivalent = "\u{1b}"
        let save = NSButton(title: "Save", target: self, action: #selector(savePressed))
        save.keyEquivalent = "\r"
        save.bezelStyle = .rounded

        let buttons = NSStackView(views: [NSView(), cancel, save])
        buttons.orientation = .horizontal
        buttons.spacing = 8

        let stack = NSStackView(views: [title, subtitle, mode, recorder, separator, agentTitle, agentSubtitle, harness, agentFields, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 22, left: 24, bottom: 20, right: 24)
        stack.translatesAutoresizingMaskIntoConstraints = false
        buttons.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        mode.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        recorder.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        recorder.heightAnchor.constraint(equalToConstant: 44).isActive = true
        separator.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        harness.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        agentFields.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])

        self.window = window
        self.modeControl = mode
        self.recorder = recorder
        harnessControl = harness
        providerControl = provider
        modelControl = model
        updateAgentControls()
        NSApp.activate(ignoringOtherApps: true)
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        window = nil
        modeControl = nil
        recorder = nil
        harnessControl = nil
        providerControl = nil
        modelControl = nil
        onSave = nil
    }

    @objc private func harnessChanged() {
        updateAgentControls()
    }

    @objc private func modeChanged() {
        guard let modeControl, let recorder else { return }
        if modeControl.selectedSegment == 0 {
            draft = .defaultValue
            recorder.isEnabled = false
        } else {
            recorder.isEnabled = true
            draft = recorder.shortcut
            window?.makeFirstResponder(recorder)
        }
    }

    @objc private func cancelPressed() {
        window?.close()
    }

    @objc private func savePressed() {
        guard let harnessControl, let providerControl, let modelControl else { return }
        let harness: AgentHarness = harnessControl.indexOfSelectedItem == 0 ? .claudeCodeACP : .pi
        let provider = providerControl.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let model = modelControl.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if harness == .pi && (provider.isEmpty || model.isEmpty) {
            NSSound.beep()
            return
        }
        let agent = AgentBackendConfiguration(harness: harness, provider: provider, model: model)
        onSave?(draft, agent)
        window?.close()
    }

    private func updateAgentControls() {
        guard let harnessControl, let providerControl, let modelControl else { return }
        let usesPi = harnessControl.indexOfSelectedItem == 1
        providerControl.isEnabled = usesPi
        modelControl.isEnabled = usesPi
    }
}

private final class VoiceShortcutRecorderView: NSControl {
    var shortcut = VoiceShortcutConfiguration.optionSpace {
        didSet { needsDisplay = true }
    }
    var onChange: ((VoiceShortcutConfiguration) -> Void)?
    override var acceptsFirstResponder: Bool { true }

    override var isEnabled: Bool {
        didSet {
            if !isEnabled, window?.firstResponder === self { window?.makeFirstResponder(nil) }
            needsDisplay = true
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        window?.makeFirstResponder(self)
    }

    override func keyDown(with event: NSEvent) {
        guard isEnabled else { return }
        let modifiers = carbonModifiers(event.modifierFlags)
        guard modifiers != 0, !Self.modifierKeyCodes.contains(event.keyCode) else {
            NSSound.beep()
            return
        }
        let next = VoiceShortcutConfiguration(
            mode: .keyCombination,
            keyCode: UInt32(event.keyCode),
            carbonModifiers: modifiers,
            keyLabel: keyLabel(for: event)
        )
        shortcut = next
        onChange?(next)
    }

    override func becomeFirstResponder() -> Bool {
        needsDisplay = true
        return true
    }

    override func resignFirstResponder() -> Bool {
        needsDisplay = true
        return true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let focused = window?.firstResponder === self
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8)
        (isEnabled ? NSColor.controlBackgroundColor : NSColor.disabledControlTextColor.withAlphaComponent(0.08)).setFill()
        path.fill()
        (focused ? NSColor.controlAccentColor : NSColor.separatorColor).setStroke()
        path.lineWidth = focused ? 2 : 1
        path.stroke()

        let text = focused ? "Press a shortcut..." : shortcut.displayName
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 14, weight: .medium),
            .foregroundColor: isEnabled ? NSColor.labelColor : NSColor.secondaryLabelColor,
        ]
        let size = text.size(withAttributes: attributes)
        text.draw(at: NSPoint(x: 14, y: (bounds.height - size.height) / 2), withAttributes: attributes)
    }

    private static let modifierKeyCodes: Set<UInt16> = [
        UInt16(kVK_Command), UInt16(kVK_RightCommand), UInt16(kVK_Shift), UInt16(kVK_RightShift),
        UInt16(kVK_Option), UInt16(kVK_RightOption), UInt16(kVK_Control), UInt16(kVK_RightControl),
        UInt16(kVK_CapsLock), UInt16(kVK_Function),
    ]
}

private func carbonModifiers(_ flags: NSEvent.ModifierFlags) -> UInt32 {
    let flags = flags.intersection(.deviceIndependentFlagsMask)
    var result: UInt32 = 0
    if flags.contains(.control) { result |= UInt32(controlKey) }
    if flags.contains(.option) { result |= UInt32(optionKey) }
    if flags.contains(.shift) { result |= UInt32(shiftKey) }
    if flags.contains(.command) { result |= UInt32(cmdKey) }
    return result
}

private func keyLabel(for event: NSEvent) -> String {
    switch Int(event.keyCode) {
    case kVK_Space: return "Space"
    case kVK_Return: return "Return"
    case kVK_Tab: return "Tab"
    case kVK_Escape: return "Escape"
    case kVK_Delete: return "Delete"
    case kVK_ForwardDelete: return "Forward Delete"
    case kVK_LeftArrow: return "Left Arrow"
    case kVK_RightArrow: return "Right Arrow"
    case kVK_UpArrow: return "Up Arrow"
    case kVK_DownArrow: return "Down Arrow"
    default:
        let value = event.charactersIgnoringModifiers?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() ?? ""
        return value.isEmpty ? "Key \(event.keyCode)" : value
    }
}
