import Foundation

enum LocalEnvironment {
    static func value(_ key: String) -> String? {
        if let processValue = ProcessInfo.processInfo.environment[key], !processValue.isEmpty {
            return processValue
        }
        return loadedValues[key]
    }

    private static let loadedValues: [String: String] = {
        var merged: [String: String] = [:]
        for url in candidateEnvFiles() where FileManager.default.fileExists(atPath: url.path) {
            do {
                let values = try parseEnvFile(at: url)
                merged.merge(values) { current, _ in current }
            } catch {
                preconditionFailure("Could not read Metaflow environment file at \(url.path): \(error)")
            }
        }
        return merged
    }()

    private static func candidateEnvFiles() -> [URL] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        var candidates: [URL] = []
        if let explicit = ProcessInfo.processInfo.environment["METAFLOW_ENV_FILE"], !explicit.isEmpty {
            candidates.append(URL(fileURLWithPath: explicit))
        }
        candidates.append(contentsOf: envFilesSearchingUpward(
            from: URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true),
            limit: 6
        ))
        candidates.append(home.appendingPathComponent(".config/metaflow/.env"))
        candidates.append(home.appendingPathComponent(".hermes/.env"))
        // Migration source for the existing Ambient installation.
        candidates.append(home.appendingPathComponent("agent/ambient/.env"))

        var seen = Set<String>()
        return candidates.filter { seen.insert($0.standardizedFileURL.path).inserted }
    }

    private static func envFilesSearchingUpward(from start: URL, limit: Int) -> [URL] {
        var result: [URL] = []
        var directory = start
        for _ in 0..<limit {
            result.append(directory.appendingPathComponent(".env"))
            let parent = directory.deletingLastPathComponent()
            guard parent.path != directory.path else { break }
            directory = parent
        }
        return result
    }

    private static func parseEnvFile(at url: URL) throws -> [String: String] {
        let contents = try String(contentsOf: url, encoding: .utf8)
        var values: [String: String] = [:]
        for (index, rawLine) in contents.components(separatedBy: .newlines).enumerated() {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty, !line.hasPrefix("#") else { continue }
            guard let equals = line.firstIndex(of: "=") else {
                throw LocalEnvironmentError.invalidLine(url.path, index + 1)
            }
            let key = line[..<equals].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { throw LocalEnvironmentError.invalidLine(url.path, index + 1) }
            var value = line[line.index(after: equals)...].trimmingCharacters(in: .whitespacesAndNewlines)
            if (value.hasPrefix("\"") && value.hasSuffix("\"")) ||
                (value.hasPrefix("'") && value.hasSuffix("'")) {
                value = String(value.dropFirst().dropLast())
            }
            values[key] = value
        }
        return values
    }
}

enum LocalEnvironmentError: LocalizedError {
    case invalidLine(String, Int)

    var errorDescription: String? {
        switch self {
        case .invalidLine(let path, let line):
            return "Invalid environment assignment at \(path):\(line)."
        }
    }
}
