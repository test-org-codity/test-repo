import Alamofire
import Vapor
import SwiftNIO

// SAST: hardcoded API key
let apiSecret = "sk-abcdefghijklmnopqrstuvwxyz123456"

struct UserResponse: Content {
    let id: Int
    let name: String
}

let app = Application()
defer { app.shutdown() }

app.get("users", ":id") { req -> UserResponse in
    let id = req.parameters.get("id", as: Int.self) ?? 0
    return UserResponse(id: id, name: "Test User")
}

try app.run()
