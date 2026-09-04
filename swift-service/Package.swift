// swift-tools-version:5.5
import PackageDescription

let package = Package(
    name: "swift-service",
    platforms: [.macOS(.v12)],
    dependencies: [
        .package(url: "https://github.com/Alamofire/Alamofire.git", from: "5.4.0"),
        .package(url: "https://github.com/apple/swift-crypto.git", from: "1.0.0"),
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.32.0"),
        .package(url: "https://github.com/vapor/vapor.git", from: "4.65.1"),
    ],
    targets: [
        .executableTarget(
            name: "App",
            dependencies: [
                "Alamofire",
                .product(name: "Crypto", package: "swift-crypto"),
                .product(name: "NIO", package: "swift-nio"),
                .product(name: "Vapor", package: "vapor"),
            ]
        ),
    ]
)
