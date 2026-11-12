import Foundation
import Testing
@testable import DigUpKit

@Suite struct RulesTests {
    let folder: URL = {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("DigUpTests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    @Test func typeScriptIsNotVideo() throws {
        let file = folder.appendingPathComponent("app.ts")
        try "export const x: number = 1;\n".write(to: file, atomically: true, encoding: .utf8)
        #expect(Rules.classify(file, type: .init(filenameExtension: "ts"), options: IndexOptions()) == .skip("code or data file"))
    }

    @Test func realTransportStreamIsVideo() throws {
        var bytes = [UInt8](repeating: 0xFF, count: 188 * 4)
        for packet in 0..<4 { bytes[packet * 188] = 0x47 }
        let file = folder.appendingPathComponent("clip.ts")
        try Data(bytes).write(to: file)
        #expect(Rules.classify(file, type: .init(filenameExtension: "ts"), options: IndexOptions()) == .index(.video))
    }

    @Test func codeCanBeIncluded() {
        var options = IndexOptions()
        options.includeCode = true
        let file = folder.appendingPathComponent("main.py")
        #expect(Rules.classify(file, type: .init(filenameExtension: "py"), options: options) == .index(.doc))
    }

    @Test func machineNames() {
        #expect(Rules.looksMachineNamed("clip_000123"))
        #expect(Rules.looksMachineNamed("frame-0042"))
        #expect(Rules.looksMachineNamed("3f9a1c0e-12ab-4cde"))
        #expect(Rules.looksMachineNamed("000123"))
        #expect(!Rules.looksMachineNamed("IMG_1234"))
        #expect(!Rules.looksMachineNamed("PXL_20260101_123456789"))
        #expect(!Rules.looksMachineNamed("Screenshot 2026-10-01 at 9.41.07 PM"))
        #expect(!Rules.looksMachineNamed("Tokyo itinerary"))
    }

    @Test func datasetNeedsManyMachineNamedFiles() {
        let clips = (0..<400).map { (folder: "/x/clips", stem: String(format: "clip_%06d", $0), kind: FileKind.audio) }
        let photos = (0..<400).map { (folder: "/x/camera", stem: "IMG_\(1000 + $0)", kind: FileKind.image) }
        let few = (0..<50).map { (folder: "/x/few", stem: "clip_\($0)", kind: FileKind.audio) }
        let datasets = Rules.datasetFolders(clips + photos + few, roots: [])
        #expect(datasets == ["/x/clips": 400])
    }

    @Test func ftsQueryDropsStopwordsAndKindWords() {
        #expect(Searcher.ftsQuery("the screenshot of my payment error") == "\"payment\" OR \"error\"")
        #expect(Searcher.ftsQuery("zebr", prefixLast: true) == "\"zebr\"*")
        #expect(Searcher.ftsQuery("a screenshot") == nil)
    }

    @Test func chunksOverlapAndRespectWords() {
        let text = (1...600).map { "word\($0)" }.joined(separator: " ")
        let chunks = DocExtractor.chunks(text, size: 500, overlap: 100, limit: 100)
        #expect(chunks.count > 5)
        #expect(chunks.allSatisfy { $0.count <= 500 })
        #expect(chunks.allSatisfy { $0.hasPrefix("word") })   // never starts mid-word
        #expect(chunks.last?.hasSuffix("word600") == true)
    }

    @Test func htmlBecomesPlainText() {
        let html = """
            <html><head><title>T</title><style>p { color: red }</style></head>
            <body><h1>Trip &amp; plans</h1><p>Fly to <b>Tokyo</b>&nbsp;on Friday.</p><script>var x = 1;</script>
            <p>Caf&#233; &#x2014; ramen</p><!-- hidden --></body></html>
            """
        #expect(DocExtractor.plainText(fromHTML: html) == "Trip & plans\nFly to Tokyo on Friday.\nCafé — ramen")
    }

    @Test func halfVectorsConvertBackExactly() throws {
        let vector = (0..<Vectors.dimension).map { Float(sin(Double($0) * 0.37)) * 0.05 }
        let storage = try #require(VectorStorage(rows: 2))
        Vectors.half(vector).copyBytes(to: UnsafeMutableRawBufferPointer(start: storage.halves + Vectors.dimension,
                                                                         count: Vectors.dimension * 2))
        Vectors.floats(fromHalf: storage.halves, count: Vectors.dimension * 2, to: storage.block)
        let back = Array(UnsafeBufferPointer(start: storage.block + Vectors.dimension, count: Vectors.dimension))
        #expect(back == vector.map { Float(Float16($0)) })
        #expect(storage.block[0] == 0)   // fresh mmap'd memory is zeroed, and row 0 was left alone
    }

    @Test func meaningTakesOutEachModalitysLevelOnOneScale() {
        // Text scores sit higher than image scores here: that level comes out. The spread is shared, so a modality
        // whose scores are bunched up doesn't get its best ones inflated: 0.01 above average beats 0.002 above, 5:1.
        let text: [Float] = (0..<30).map { 0.70 + Float($0 % 3) * 0.01 }
        let image: [Float] = (0..<30).map { 0.55 + Float($0 % 3) * 0.002 }
        let scores = text + image
        let modality = Array(repeating: Modality.text, count: 30) + Array(repeating: Modality.image, count: 30)
        let z = Searcher.meaning(scores, modality)
        #expect(abs(z[1]) < 1e-4 && abs(z[31]) < 1e-4)   // 0.71 and 0.552: each at its modality's average
        #expect(abs(z[2] / z[32] - 5) < 0.01)
        let means = Searcher.modalityMeans(scores, modality)
        #expect(abs(means[.text]! - 0.71) < 0.001 && abs(means[.image]! - 0.552) < 0.001)
        #expect(abs(means[.audio]! - 0.631) < 0.001)   // no audio vectors: the average of all
    }

    @Test func laterPagesAreScoredWithoutMovingTheScale() {
        // A long book's later pages, far from the query, would pull the text average down and lift all text.
        let scores: [Float] = (0..<30).map { 0.70 + Float($0 % 3) * 0.01 } + (0..<30).map { 0.55 + Float($0 % 3) * 0.002 }
        let modality = Array(repeating: Modality.text, count: 30) + Array(repeating: Modality.image, count: 30)
        let book: [Float] = (0..<400).map { 0.60 + Float($0 % 5) * 0.004 } + [0.80]   // one page that matches
        let z = Searcher.meaning(scores, modality)
        let withBook = Searcher.meaning(scores + book, modality + Array(repeating: .text, count: book.count),
                                        setsScale: Array(repeating: true, count: 60) + Array(repeating: false, count: 401))
        for row in 0..<60 { #expect(abs(z[row] - withBook[row]) < 1e-9) }
        #expect(withBook.last! > z.max()!)   // the matching page stands out on the same scale
    }

    @Test func codesAndLongNumbersAreLookups() {
        #expect(Searcher.isLookup(["k7q2lm"]))
        #expect(Searcher.isLookup(["trx50"]))
        #expect(Searcher.isLookup(["4815162342"]))
        #expect(Searcher.isLookup(["2041"]))
        #expect(!Searcher.isLookup(["417"]))           // too short to be an ID
        #expect(!Searcher.isLookup(["inv", "2041"]))    // a word in it
        #expect(!Searcher.isLookup([]))
    }

    @Test func weakerMatchesFoldBelowHalfTheTopScore() {
        func hit(_ score: Double) -> SearchHit {
            SearchHit(path: "/\(score)", kind: .image, score: score, z: nil, cosine: nil, keywordRank: nil, segment: .image,
                      segmentID: 1, loc: nil, locEnd: nil, excerpt: nil, modified: 0, size: 0, info: [:])
        }
        #expect(Searcher.strongCount([hit(6), hit(4.1), hit(3), hit(2.9), hit(0.7)]) == 3)
        #expect(Searcher.strongCount([hit(0.71)]) == 1)
        #expect(Searcher.strongCount([]) == 0)
    }

    @Test func nestedRootsAreCrawledOnce() throws {
        let inner = folder.appendingPathComponent("inner")
        try FileManager.default.createDirectory(at: inner, withIntermediateDirectories: true)
        try Data("notes about the trip".utf8).write(to: inner.appendingPathComponent("trip.txt"))
        let report = Crawler.crawl([folder, inner], options: IndexOptions())
        #expect(report.candidates.map { ($0.path as NSString).lastPathComponent } == ["trip.txt"])
    }
}

// A crawl repeats for as long as the service runs: it must stay out of trees that hold nothing of the user's.
@Suite struct CrawlPruningTests {
    let folder: URL = {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("DigUpPrune-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    private func write(_ path: String, _ text: String = "notes") throws {
        let url = folder.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }

    private func names(_ report: CrawlReport) -> [String] {
        report.candidates.map { String($0.path.dropFirst(FolderSelection.realPath(folder.path).count + 1)) }.sorted()
    }

    @Test func kindsComeFromExtensionsAlone() throws {
        for name in ["a.pdf", "photo.png", "Screenshot 2026-11-12 at 10.00.00.png", "song.mp3", "clip.mov", "notes.md",
                     "data.bin", "README"] {
            try write(name)
        }
        let kinds = Dictionary(uniqueKeysWithValues: Crawler.crawl([folder], options: IndexOptions()).candidates.map {
            (($0.path as NSString).lastPathComponent, $0.kind)
        })
        #expect(kinds == ["a.pdf": .pdf, "photo.png": .image, "Screenshot 2026-11-12 at 10.00.00.png": .screenshot,
                          "song.mp3": .audio, "clip.mov": .video, "notes.md": .doc])
    }

    @Test func packageStoresCachesAndEnvironmentsAreNotWalked() throws {
        try write("keep/plan.txt")
        try write("node_modules/pkg/readme.md")
        try write("Caches/thing/readme.md")
        try write("tool/CACHEDIR.TAG", "Signature: 8a477f597d28d172789f06886806bc55")
        try write("tool/registry/readme.md")
        try write("env/pyvenv.cfg", "home = /usr/bin")
        try write("env/lib/readme.md")
        try write("private/.metadata_never_index", "")
        try write("private/diary.txt")
        let report = Crawler.crawl([folder], options: IndexOptions())
        #expect(names(report) == ["keep/plan.txt"])
        #expect(report.skippedFolders == ["developer folder": 1, "cache folder": 2, "python environment": 1,
                                          "marked not to index": 1])
    }

    @Test func aReposOwnCacheFolderIsStillCode() throws {
        try write("repo/cache/store.swift", "struct Store {}")
        try write("repo/node_modules/pkg/index.js", "module.exports = 1")
        var options = IndexOptions()
        options.code = true
        #expect(names(Crawler.crawl([folder], options: options)) == ["repo/cache/store.swift"])
    }

    @Test func hashStoresAreNotWalkedButDayFoldersAre() throws {
        for byte in 0..<64 { try write(String(format: "store/v10/files/%02x/blob.md", byte * 4)) }
        for day in 1...31 { try write(String(format: "journal/2026-10/%02d/entry.md", day)) }
        let report = Crawler.crawl([folder], options: IndexOptions())
        #expect(names(report).count == 31)
        #expect(names(report).allSatisfy { $0.hasPrefix("journal/") })
        #expect(report.skippedFolders == ["content-addressed store": 1])
        #expect(!Rules.looksContentAddressed((0..<40).map { String(format: "%02d", $0) }))   // no letter: not hashes
        #expect(!Rules.looksContentAddressed((0..<20).map { String(format: "%02x", $0 * 12) }))   // too few
        #expect(Rules.looksContentAddressed((0..<256).map { String(format: "%02x", $0) } + ["info", "pack", ".DS_Store"]))
    }

    @Test func projectsGiveUpScreenshotsNearTheTopOnly() throws {
        try write("app/package.json", "{}")
        try write("app/Screenshot 1.png")
        try write("app/docs/img/Screenshot 2.png")
        try write("app/a/b/c/d/Screenshot 3.png")       // four folders down: still looked at
        try write("app/a/b/c/d/e/Screenshot 4.png")     // deeper: source and generated trees
        try write("app/dist/Screenshot 5.png")          // build output
        try write("app/docs/guide.md")                  // a project's own docs aren't the user's documents
        try write("app/packages/web/package.json", "{}")
        try write("app/packages/web/a/b/c/d/Screenshot 6.png")   // a nested project counts from its own root
        try write("loose/a/b/c/d/e/f/deep.txt")         // outside a project there is no depth limit
        let report = Crawler.crawl([folder], options: IndexOptions())
        #expect(names(report) == ["app/Screenshot 1.png", "app/a/b/c/d/Screenshot 3.png", "app/docs/img/Screenshot 2.png",
                                  "app/packages/web/a/b/c/d/Screenshot 6.png", "loose/a/b/c/d/e/f/deep.txt"])
        #expect(report.skippedFolders == ["deep inside a code project": 1, "vendored or built code": 1])
    }

    @Test func aFolderChosenDeepInAProjectIsWalkedWholeInEitherOrder() throws {
        try write("app/package.json", "{}")
        try write("app/a/b/c/d/e/Screenshot 8.png")
        let app = folder.appendingPathComponent("app"), deep = folder.appendingPathComponent("app/a/b/c/d")
        #expect(names(Crawler.crawl([app], options: IndexOptions())).isEmpty)
        #expect(names(Crawler.crawl([app, deep], options: IndexOptions())) == ["app/a/b/c/d/e/Screenshot 8.png"])
        #expect(names(Crawler.crawl([deep, app], options: IndexOptions())) == ["app/a/b/c/d/e/Screenshot 8.png"])
    }

    @Test func aChosenProjectFolderIsStillAProject() throws {
        try write("go.mod", "module x")
        try write("notes.md")
        try write("Screenshot 7.png")
        // /var/folders/…, where the walk reports /private/var/folders/…
        let report = Crawler.crawl([folder.standardizedFileURL], options: IndexOptions())
        #expect(names(report) == ["Screenshot 7.png"])
    }

    @Test func evictedFilesKeepTheirRowsWhateverTheirNumber() throws {
        try write("docs/a.txt", "alpha")
        try write("docs/b.txt", "beta")
        let store = try IndexStore(directory: folder.appendingPathComponent("index.noindex"))
        let indexer = try Indexer(store: store, options: IndexOptions(), makeEmbedder: {
            throw WorkerError.notFound("sync does not need a model")
        })
        let docs = folder.appendingPathComponent("docs")
        #expect(try indexer.sync([docs]).added == 2)
        try FileManager.default.removeItem(at: docs.appendingPathComponent("b.txt"))
        let summary = try indexer.sync([docs])
        #expect(summary.removed == 1 && summary.unchanged == 1)
    }
}
