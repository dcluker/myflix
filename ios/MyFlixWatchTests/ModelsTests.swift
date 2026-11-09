import XCTest
@testable import MyFlixWatch

final class ModelsTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(json.utf8)) }

    func testEpisodeUsesTheSeriesPosterNotTheStill() throws {
        let it: MediaItem = try decode(#"{"id":"e1","type":"Episode","name":"Pilot","seriesId":"s1","seriesName":"Barry","season":3,"episode":5,"img":{"primary":"still"},"seriesImg":{"primary":"poster"}}"#)
        XCTAssertEqual(it.posterPath, "/img/s1/Primary?tag=poster&w=160")
        XCTAssertEqual(it.title, "Barry")
        XCTAssertEqual(it.subtitle, "S3:E5")
    }

    func testMovieUsesItsOwnPosterAndYear() throws {
        let it: MediaItem = try decode(#"{"id":"m1","type":"Movie","name":"Falling Down","year":1993,"img":{"primary":"t"}}"#)
        XCTAssertEqual(it.posterPath, "/img/m1/Primary?tag=t&w=160")
        XCTAssertEqual(it.subtitle, "1993")
    }

    func testContinueListKeepsOneEntryPerShowAndResumeFirst() throws {
        let home: HomeResponse = try decode("""
        {"resume":[{"id":"e1","type":"Episode","name":"A","seriesId":"s1","seriesName":"Show"},{"id":"m1","type":"Movie","name":"Film"}],
         "nextUp":[{"id":"e2","type":"Episode","name":"B","seriesId":"s1","seriesName":"Show"},{"id":"e9","type":"Episode","name":"C","seriesId":"s2","seriesName":"Other"}],
         "latest":[]}
        """)
        XCTAssertEqual(home.continueList.map(\.id), ["e1", "m1", "e9"])
    }

    func testNowPlayingFractionAndLabels() throws {
        let n: NowPlaying = try decode(#"{"itemId":"i","name":"Pilot","seriesName":"Barry","season":3,"episode":5,"paused":false,"positionMs":500,"runtimeMs":2000,"img":null}"#)
        XCTAssertEqual(n.fraction, 0.25, accuracy: 0.001)
        XCTAssertEqual(n.title, "Barry")
        XCTAssertEqual(n.subtitle, "S3:E5  Pilot")
        let m: NowPlaying = try decode(#"{"itemId":"i","name":"Movie","paused":true,"positionMs":9999999,"runtimeMs":1000,"img":null}"#)
        XCTAssertEqual(m.fraction, 1)
        XCTAssertNil(m.subtitle)
    }

    func testMissingRuntimeIsZeroProgress() throws {
        let n: NowPlaying = try decode(#"{"itemId":"i","name":"X","paused":false,"positionMs":10,"img":null}"#)
        XCTAssertEqual(n.fraction, 0)
    }
}
