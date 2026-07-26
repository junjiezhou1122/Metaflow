// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MetaflowMac",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "metaflow-mac", targets: ["MetaflowMac"])
    ],
    dependencies: [
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui.git", from: "2.4.1")
    ],
    targets: [
        .executableTarget(
            name: "MetaflowMac",
            dependencies: [
                .product(name: "MarkdownUI", package: "swift-markdown-ui")
            ],
            path: "Sources/MetaflowMac"
        ),
        .testTarget(
            name: "MetaflowMacTests",
            dependencies: ["MetaflowMac"]
        )
    ]
)
