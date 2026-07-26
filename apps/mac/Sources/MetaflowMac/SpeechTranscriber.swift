import Foundation

@MainActor
protocol SpeechTranscriber: AnyObject {
    func start() async throws
    func finish() async throws -> String
    func cancel()
}

enum SpeechTranscriberFactory {
    @MainActor
    static func make() throws -> SpeechTranscriber {
        VolcengineRealtimeASRTranscriber(configuration: try VolcengineASRConfiguration.fromEnvironment())
    }
}
