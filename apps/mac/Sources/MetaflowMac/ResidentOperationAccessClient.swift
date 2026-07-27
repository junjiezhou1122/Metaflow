import CryptoKit
import Foundation

enum ResidentOperationAccessError: LocalizedError {
    case invalidEndpoint
    case invalidToken
    case invalidChallenge
    case unreachable(String)
    case invalidResponse(String)
    case incompatible(String)

    var errorDescription: String? {
        switch self {
        case .invalidEndpoint:
            return "Resident daemon endpoint must be a credential-free loopback HTTP origin."
        case .invalidToken:
            return "Resident daemon Operation token is invalid."
        case .invalidChallenge:
            return "Resident daemon doctor challenge is invalid."
        case .unreachable(let detail):
            return "Resident daemon is unreachable: \(detail)"
        case .invalidResponse(let detail):
            return "Resident daemon returned an invalid response: \(detail)"
        case .incompatible(let detail):
            return "Resident daemon contract is incompatible: \(detail)"
        }
    }
}

struct ResidentOperationWireContract {
    static let protocolName = "metaflow-operations-http"
    static let protocolVersion = 1
    static let serverName = "ambient-daemon"
    static let serverVersion = "0.1.0"
    static let catalogVersion = 1
    static let catalogFingerprint = "sha256:848d837bc51def904f31e2c546ecce93d286b8140f70ead30d863f37d276d51a"
    static let authenticationSource = "METAFLOW_AUTH_TOKEN"
    static let authenticationRequired = true
    static let authenticationScheme = "Bearer"
    static let challengeScheme = "HMAC-SHA256"
    static let operationsEndpoint = "/metaflow/v1/operations/"
    static let mcpEndpoint = "/mcp"
    static let operations = [
        "catalog.list",
        "connector.list",
        "connector.inspect",
        "capture.ingest",
        "capture.connection.list",
        "capture.connection.create",
        "capture.connection.check",
        "capture.connection.discover",
        "capture.connection.activate",
        "capture.connection.update",
        "capture.connection.pause",
        "capture.connection.run",
        "capture.dlq.list",
        "capture.dlq.replay",
        "view.get",
        "view.graph.project",
        "view.search",
        "view.search.reindex",
        "view.traverse",
        "view.tombstone",
        "view.authoring.request",
        "view.authoring.propose",
        "view.authoring.inspect",
        "view.authoring.approve",
        "view.authoring.reject",
        "view.authoring.apply",
        "transformation.submit",
        "transformation.get",
        "run.execute",
        "run.inspect",
        "run.cancel",
        "feedback.submit",
        "feedback.apply",
        "failure.inspect",
        "policy.decision.get",
        "privacy.forget.request",
        "privacy.forget.execute",
        "privacy.forget.inspect",
        "trace.read"
    ]
}

struct ResidentOperationAccessClient: Sendable {
    private let endpoint: URL
    private let endpointOrigin: String
    private let token: String
    private let session: URLSession

    init(endpoint: URL, token: String, session: URLSession = .shared) throws {
        guard token.range(of: #"^[A-Za-z0-9._~+/-]{32,}=*$"#, options: .regularExpression) != nil else {
            throw ResidentOperationAccessError.invalidToken
        }
        let parsed = try Self.parseEndpoint(endpoint)
        self.endpoint = parsed.url
        self.endpointOrigin = parsed.origin
        self.token = token
        self.session = session
    }

    func loadExactView(viewID: String, revision: Int) async throws -> Data {
        guard !viewID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, revision > 0 else {
            throw ResidentOperationAccessError.invalidResponse("exact View reference is invalid")
        }
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
            throw ResidentOperationAccessError.invalidEndpoint
        }
        components.path = "/context/v1/views/\(viewID)"
        components.queryItems = [URLQueryItem(name: "revision", value: String(revision))]
        guard let url = components.url else { throw ResidentOperationAccessError.invalidEndpoint }
        let request = try await authorize(URLRequest(url: url, timeoutInterval: 10))
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw ResidentOperationAccessError.unreachable(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw ResidentOperationAccessError.invalidResponse("exact View request failed")
        }
        return data
    }

    func authorize(_ input: URLRequest) async throws -> URLRequest {
        guard let inputURL = input.url,
              var components = URLComponents(url: inputURL, resolvingAgainstBaseURL: false),
              components.scheme == "http",
              let host = components.host?.lowercased(),
              host == "127.0.0.1" || host == "localhost",
              components.user == nil,
              components.password == nil else {
            throw ResidentOperationAccessError.invalidEndpoint
        }
        components.host = "127.0.0.1"
        guard let requestURL = components.url, requestURL.originString == endpointOrigin else {
            throw ResidentOperationAccessError.invalidEndpoint
        }
        let challenge = Self.randomChallenge()
        let doctorRequest = try makeDoctorRequest(challenge: challenge)
        let doctorData: Data
        let doctorResponse: URLResponse
        do {
            (doctorData, doctorResponse) = try await session.data(for: doctorRequest)
        } catch {
            throw ResidentOperationAccessError.unreachable(error.localizedDescription)
        }
        try validateDoctor(data: doctorData, response: doctorResponse, challenge: challenge)

        var request = input
        request.url = requestURL
        request.httpShouldHandleCookies = false
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    func makeDoctorRequest(challenge: String) throws -> URLRequest {
        guard challenge.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
            throw ResidentOperationAccessError.invalidChallenge
        }
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
            throw ResidentOperationAccessError.invalidEndpoint
        }
        components.path = "/metaflow/v1/doctor"
        components.queryItems = [URLQueryItem(name: "challenge", value: challenge)]
        guard let url = components.url else { throw ResidentOperationAccessError.invalidEndpoint }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 10)
        request.httpMethod = "GET"
        request.httpShouldHandleCookies = false
        return request
    }

    func validateDoctor(data: Data, response: URLResponse, challenge: String) throws {
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw ResidentOperationAccessError.invalidResponse("doctor did not return HTTP 200")
        }
        guard http.value(forHTTPHeaderField: "x-metaflow-protocol-version") == String(ResidentOperationWireContract.protocolVersion) else {
            throw ResidentOperationAccessError.incompatible("protocol header mismatch")
        }
        let json: Any
        do {
            json = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw ResidentOperationAccessError.invalidResponse("doctor body is not JSON")
        }
        let body = try exactRecord(json, keys: ["ok", "protocol", "server", "authentication", "catalog", "endpoints"], label: "doctor")
        guard body["ok"] as? Bool == true else { throw ResidentOperationAccessError.incompatible("doctor reported failure") }

        let protocolBody = try exactRecord(body["protocol"], keys: ["name", "version"], label: "protocol")
        guard protocolBody["name"] as? String == ResidentOperationWireContract.protocolName,
              protocolBody["version"] as? Int == ResidentOperationWireContract.protocolVersion else {
            throw ResidentOperationAccessError.incompatible("protocol mismatch")
        }
        let server = try exactRecord(body["server"], keys: ["name", "version", "origin"], label: "server")
        guard server["name"] as? String == ResidentOperationWireContract.serverName,
              server["version"] as? String == ResidentOperationWireContract.serverVersion,
              server["origin"] as? String == endpointOrigin else {
            throw ResidentOperationAccessError.incompatible("server identity or origin mismatch")
        }
        let authentication = try exactRecord(
            body["authentication"],
            keys: ["source", "required", "scheme", "challenge_scheme", "challenge", "proof"],
            label: "authentication"
        )
        guard authentication["source"] as? String == ResidentOperationWireContract.authenticationSource,
              authentication["required"] as? Bool == ResidentOperationWireContract.authenticationRequired,
              authentication["scheme"] as? String == ResidentOperationWireContract.authenticationScheme,
              authentication["challenge_scheme"] as? String == ResidentOperationWireContract.challengeScheme,
              authentication["challenge"] as? String == challenge,
              let proof = authentication["proof"] as? String,
              proof.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
            throw ResidentOperationAccessError.incompatible("authentication contract mismatch")
        }
        let catalog = try exactRecord(body["catalog"], keys: ["version", "fingerprint", "operations"], label: "catalog")
        guard catalog["version"] as? Int == ResidentOperationWireContract.catalogVersion,
              catalog["fingerprint"] as? String == ResidentOperationWireContract.catalogFingerprint,
              catalog["operations"] as? [String] == ResidentOperationWireContract.operations else {
            throw ResidentOperationAccessError.incompatible("Operation catalog mismatch")
        }
        let endpoints = try exactRecord(body["endpoints"], keys: ["operations", "mcp"], label: "endpoints")
        guard endpoints["operations"] as? String == ResidentOperationWireContract.operationsEndpoint,
              endpoints["mcp"] as? String == ResidentOperationWireContract.mcpEndpoint else {
            throw ResidentOperationAccessError.incompatible("endpoint contract mismatch")
        }
        let expectedProof = Self.doctorProof(token: token, challenge: challenge, endpointOrigin: endpointOrigin)
        guard Self.constantTimeEqual(proof, expectedProof) else {
            throw ResidentOperationAccessError.incompatible("doctor credential proof mismatch")
        }
    }

    private static func parseEndpoint(_ endpoint: URL) throws -> (url: URL, origin: String) {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false),
              components.scheme == "http",
              let host = components.host?.lowercased(),
              host == "127.0.0.1" || host == "localhost",
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.path.isEmpty || components.path == "/" else {
            throw ResidentOperationAccessError.invalidEndpoint
        }
        components.host = "127.0.0.1"
        components.path = "/"
        components.query = nil
        components.fragment = nil
        guard let url = components.url else { throw ResidentOperationAccessError.invalidEndpoint }
        let port = components.port.map { ":\($0)" } ?? ""
        return (url, "http://127.0.0.1\(port)")
    }

    private static func randomChallenge() -> String {
        (0..<32).map { _ in String(format: "%02x", UInt8.random(in: .min ... .max)) }.joined()
    }

    private static func doctorProof(token: String, challenge: String, endpointOrigin: String) -> String {
        let message = "metaflow-doctor-v1:\(challenge):\(endpointOrigin):\(ResidentOperationWireContract.catalogFingerprint)"
        let key = SymmetricKey(data: Data(token.utf8))
        let signature = HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: key)
        return Data(signature).map { String(format: "%02x", $0) }.joined()
    }

    private static func constantTimeEqual(_ first: String, _ second: String) -> Bool {
        let left = Array(first.utf8)
        let right = Array(second.utf8)
        guard left.count == right.count else { return false }
        return zip(left, right).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}

private extension URL {
    var originString: String {
        guard let components = URLComponents(url: self, resolvingAgainstBaseURL: false),
              let scheme = components.scheme,
              let host = components.host else { return "" }
        let port = components.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }
}

private func exactRecord(_ value: Any?, keys: Set<String>, label: String) throws -> [String: Any] {
    guard let record = value as? [String: Any], Set(record.keys) == keys else {
        throw ResidentOperationAccessError.invalidResponse("\(label) has unknown or missing fields")
    }
    return record
}
