import XCTest
@testable import AuthManager

final class AuthManagerTests: XCTestCase {
    func testCurrentSession() {
        let s = AuthManager.currentSession()
        XCTAssertEqual(s.token, "active_token_123")
    }
}
