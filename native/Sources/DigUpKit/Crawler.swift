import Foundation
import UniformTypeIdentifiers

/// A file the crawler decided to index.
public struct Candidate: Sendable {
    public let path: String
    public let kind: FileKind
    public let size: Int64
    public let mtime: Double
    public let inode: UInt64
    public let device: UInt64
}

public struct CrawlReport: Sendable {
    public var candidates: [Candidate] = []
    // Enumeration failures protect persisted rows; an unreadable subtree is not evidence of deletion.
    fileprivate(set) var unreadable: [String] = []
    public var skipped: [String: Int] = [:]          // reason → files
    public var skippedFolders: [String: Int] = [:]   // reason → folders not walked into
    public var datasets: [String: Int] = [:]         // folder → files skipped as a dataset
}

/// Walks the chosen folders and applies `Rules`. Reads metadata only, never file contents (except the 600-byte
/// sniff that tells a real MPEG-TS video from a TypeScript file, and never of a file that's only in the cloud).
///
/// The walk is kept cheap because it repeats: it doesn't go into package stores, environments, caches, hash stores or
/// the depths of code projects (`Rules.skipReason`), and asks the file provider nothing about files it won't index.
///
/// For the code index (`IndexOptions.code`) it walks the code folders instead: code files only (`Rules.classifyCode`),
/// in a git repo only those git keeps (`GitFiles`), and none in vendored or built folders.
public enum Crawler {
    // Text readers load whole files; bound those allocations before extraction begins.
    private static let maxDocumentBytes: Int64 = 20 * 1024 * 1024
    private static let maxImageBytes: Int64 = 50 * 1024 * 1024
    private static let datalessFlag: UInt32 = 0x4000_0000   // SF_DATALESS: contents are in the cloud, not on disk

    public static func crawl(_ roots: [URL], options: IndexOptions) -> CrawlReport {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        // Only what a folder listing knows. A file's type comes from its extension and its cloud state is asked for
        // files to index: fetching both for every entry sent each one to the file provider (iCloud Drive, Dropbox),
        // and a crawl of a synced folder with a few hundred thousand files cost minutes of that daemon's CPU.
        let keys: [URLResourceKey] = [.isDirectoryKey, .isPackageKey]
        var report = CrawlReport()
        var projectRoots = Set<String>()
        var repos = GitRepos()
        var found: [Candidate] = []
        var foundPaths = Set<String>()   // a folder inside another root would be walked twice
        let rootPaths = Set(roots.map { $0.standardizedFileURL.path })
        var types: [String: UTType?] = [:]       // extension → type, without touching the file
        var syncedFolders: [String: Bool] = [:]  // folder → whether iCloud syncs it

        func type(forExtension ext: String) -> UTType? {
            if ext.isEmpty { return nil }
            if let known = types[ext] { return known }
            let type = UTType(filenameExtension: ext)
            types[ext] = type
            return type
        }

        /// Whether iCloud has a newer version than the copy here. A placeholder says so itself (`SF_DATALESS`, read
        /// with the file's size); this is asked only about files to index, in folders iCloud syncs.
        func awaitsDownload(_ url: URL) -> Bool {
            let folder = url.deletingLastPathComponent()
            let synced: Bool
            if let known = syncedFolders[folder.path] {
                synced = known
            } else {
                synced = (try? folder.resourceValues(forKeys: [.isUbiquitousItemKey]))?.isUbiquitousItem == true
                syncedFolders[folder.path] = synced
            }
            guard synced else { return false }
            let values = try? url.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey])
            return values?.isUbiquitousItem == true && values?.ubiquitousItemDownloadingStatus != .current
        }

        for root in roots.map({ $0.standardizedFileURL }) {
            // The walk reports real paths (/private/var, where the root says /var).
            let real = FolderSelection.realPath(root.path)
            // Folders inside a code project (main index): how far below its root they are. Per chosen folder: one
            // chosen deep inside a project is walked whole, whichever order the folders come in.
            var projectDepth: [String: Int] = [:]
            if options.code {
                repos.enterRoot(root.path)
            } else if Rules.isProjectRoot(root.path) {
                for path in [root.path, real] {
                    projectRoots.insert(path)
                    projectDepth[path] = 0
                }
            }
            // A skip applies inside the chosen folders that contain it: a folder chosen inside a skipped one is
            // walked whole (`FolderSelection`).
            let skips = options.excludedFolders.filter {
                FolderSelection.isInside($0, root.path) || FolderSelection.isInside($0, real)
            }.flatMap { [$0, FolderSelection.realPath($0)] }
            guard let walker = fm.enumerator(at: root, includingPropertiesForKeys: keys,
                                             options: [.skipsHiddenFiles, .skipsPackageDescendants],
                                             errorHandler: { url, _ in
                                                 report.unreadable.append(FolderSelection.realPath(url.path))
                                                 return true
                                             }) else {
                report.unreadable.append(real)
                continue
            }

            /// Why the walk doesn't go into a folder, or nil: then it's noted as a repo, a project root, or by how
            /// deep in a project it is.
            func skipReason(entering url: URL) -> String? {
                if let reason = Rules.skipReason(forFolder: url, home: home, excluded: skips, code: options.code)
                    ?? (options.code ? Rules.codeSkipReason(forFolder: url) : nil) {
                    return reason
                }
                // One listing answers the rest: markers, a hash store's fan-out, a project's files.
                let entries = (try? fm.contentsOfDirectory(atPath: url.path)) ?? []
                if let reason = Rules.skipReason(forEntries: entries) { return reason }
                if options.code {
                    repos.enter(url.path)
                    return nil
                }
                if Rules.isProjectRoot(entries: entries) {
                    projectRoots.insert(url.path)
                    projectDepth[url.path] = 0
                    return nil
                }
                // Inside a project only screenshots are indexed: not worth its build output or its deep trees.
                guard let depth = projectDepth[(url.path as NSString).deletingLastPathComponent] else { return nil }
                if Rules.codeSkippedFolderNames.contains(url.lastPathComponent) { return "vendored or built code" }
                if depth >= Rules.maxProjectDepth { return "deep inside a code project" }
                projectDepth[url.path] = depth + 1
                return nil
            }

            func notDownloaded(_ url: URL) {
                // Eviction or cloud sync is temporary unavailability, not deletion; retain saved text/vectors.
                report.unreadable.append(FolderSelection.realPath(url.path))
                report.skipped["in the cloud, not downloaded", default: 0] += 1
            }

            func visit(_ url: URL) {
                let values = try? url.resourceValues(forKeys: Set(keys))
                if values?.isDirectory == true, values?.isPackage != true {
                    if let reason = skipReason(entering: url) {
                        walker.skipDescendants()
                        report.skippedFolders[reason, default: 0] += 1
                    }
                    return
                }
                if values?.isPackage == true {
                    report.skipped["app or bundle", default: 0] += 1
                    return
                }
                let ext = url.pathExtension.lowercased()
                var info = stat()
                // Telling a video from TypeScript reads the file's first bytes, and reading a placeholder downloads
                // it: leave those unread and keep what was indexed from them.
                if Rules.sniffedExtensions.contains(ext), !options.excludedExtensions.contains(ext),
                   lstat(url.path, &info) == 0, info.st_flags & datalessFlag != 0 {
                    notDownloaded(url)
                    return
                }
                let classification = options.code ? Rules.classifyCode(url, options: options)
                    : Rules.classify(url, type: type(forExtension: ext), options: options)
                switch classification {
                case .ignore:
                    report.skipped["other type", default: 0] += 1
                case .skip(let reason):
                    report.skipped[reason, default: 0] += 1
                case .index(let kind):
                    guard lstat(url.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
                        report.skipped["link or special file", default: 0] += 1
                        return
                    }
                    // Bound whole-file text/image reads; audio/video readers stream individual windows and frames.
                    if (kind == .doc && info.st_size > maxDocumentBytes)
                        || ((kind == .image || kind == .screenshot) && info.st_size > maxImageBytes) {
                        report.skipped["exceeds memory-safe file limit", default: 0] += 1
                        return
                    }

                    // Reading a dataless placeholder (iCloud "Optimize Mac Storage", File Providers) downloads it.
                    if info.st_flags & datalessFlag != 0 || awaitsDownload(url) {
                        notDownloaded(url)
                        return
                    }
                    if options.code {
                        // Too big to be written by hand; a notebook's file holds its outputs too.
                        let limit = ext == "ipynb" ? options.maxNotebookBytes : options.maxCodeBytes
                        if info.st_size > limit {
                            report.skipped["too big to be written by hand", default: 0] += 1
                            return
                        }
                        if repos.ignores(url.path) {
                            report.skipped["ignored by git", default: 0] += 1
                            return
                        }
                    }
                    guard foundPaths.insert(url.path).inserted else { return }
                    let mtime = Double(info.st_mtimespec.tv_sec) + Double(info.st_mtimespec.tv_nsec) / 1e9
                    found.append(Candidate(path: url.path, kind: kind, size: Int64(info.st_size), mtime: mtime,
                                           inode: UInt64(info.st_ino), device: UInt64(bitPattern: Int64(info.st_dev))))
                }
            }

            // URL resource values are autoreleased; draining per file keeps a big walk from piling them up (the app
            // crawls on a background queue whose pool only drains when the whole sync is done).
            while let url = autoreleasepool(invoking: { walker.nextObject() as? URL }) {
                autoreleasepool {
                    visit(url)
                }
            }
        }

        // Inside a code project only screenshots count (assets, fixtures and datasets don't).
        var inProject: [String: Bool] = [:]
        func isInProject(_ folder: String) -> Bool {
            if let known = inProject[folder] { return known }
            let parent = (folder as NSString).deletingLastPathComponent
            let answer = projectRoots.contains(folder) || (parent != folder && parent.count > 1 && isInProject(parent))
            inProject[folder] = answer
            return answer
        }
        var kept: [Candidate] = []
        for file in found {
            if !options.code, file.kind != .screenshot, isInProject((file.path as NSString).deletingLastPathComponent) {
                report.skipped["inside a code project", default: 0] += 1
            } else {
                kept.append(file)
            }
        }

        if !options.includeDatasets, !options.code {
            let datasets = Rules.datasetFolders(kept.map {
                (($0.path as NSString).deletingLastPathComponent,
                 (($0.path as NSString).lastPathComponent as NSString).deletingPathExtension, $0.kind)
            }, roots: rootPaths)
            if !datasets.isEmpty {
                report.datasets = datasets
                kept.removeAll { file in
                    let skip = datasets[(file.path as NSString).deletingLastPathComponent] != nil
                        && [.image, .audio, .video].contains(file.kind)
                    if skip { report.skipped["dataset", default: 0] += 1 }
                    return skip
                }
            }
        }
        report.candidates = kept
        return report
    }
}

/// The git repos a code crawl walks through, and the files each keeps (`GitFiles`): a file git ignores (a build, an
/// environment, data, a secret listed in .gitignore) isn't code search's to read. A folder that isn't in a repo, or a
/// Mac without git, has no list: everything there counts.
struct GitRepos {
    /// Repo folder → the files git keeps in it (paths relative to it), or nil when git couldn't say.
    private var files: [String: Set<String>?] = [:]
    /// Folder → the repo it's in (nil: none), as the walk found them.
    private var repoOf: [String: String?] = [:]

    /// A chosen folder: a repo itself, or inside one (a repo's subfolder chosen on its own).
    mutating func enterRoot(_ path: String) {
        var folder = path
        while true {
            if FileManager.default.fileExists(atPath: folder + "/.git") {
                files[folder] = GitFiles.list(folder)
                repoOf[path] = folder
                return
            }
            let parent = (folder as NSString).deletingLastPathComponent
            guard parent != folder, parent.count > 1 else { break }
            folder = parent
        }
        repoOf[path] = .some(nil)
    }

    /// A folder the walk goes into: a repo of its own when it has a .git folder (a submodule's or a worktree's .git
    /// file keeps it out of the walk: `Rules.codeSkipReason`).
    mutating func enter(_ path: String) {
        var isFolder: ObjCBool = false
        if FileManager.default.fileExists(atPath: path + "/.git", isDirectory: &isFolder), isFolder.boolValue {
            files[path] = GitFiles.list(path)
            repoOf[path] = path
        }
    }

    /// The repo `folder` is in, from the closest folder the walk has seen.
    private mutating func repo(of folder: String) -> String? {
        if let known = repoOf[folder] { return known }
        let parent = (folder as NSString).deletingLastPathComponent
        let answer = parent != folder && parent.count > 1 ? repo(of: parent) : nil
        repoOf[folder] = answer
        return answer
    }

    /// Whether git ignores the file at `path` (in a repo whose files git listed).
    mutating func ignores(_ path: String) -> Bool {
        guard let repo = repo(of: (path as NSString).deletingLastPathComponent), let kept = files[repo] ?? nil
        else { return false }
        return !kept.contains(String(path.dropFirst(repo.count + 1)))
    }
}

/// The files git keeps in a repo: tracked ones, and new ones its .gitignore doesn't leave out.
enum GitFiles {
    /// A git that's really installed (Xcode's, the command line tools', Homebrew's). /usr/bin/git on a Mac without the
    /// developer tools only asks to install them.
    static let git: String? = {
        var candidates: [String] = []
        if let developer = try? FileManager.default.destinationOfSymbolicLink(atPath: "/var/db/xcode_select_link") {
            candidates.append(developer + "/usr/bin/git")
        }
        candidates += ["/Library/Developer/CommandLineTools/usr/bin/git",
                       "/Applications/Xcode.app/Contents/Developer/usr/bin/git", "/opt/homebrew/bin/git",
                       "/usr/local/bin/git"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }()

    /// Paths relative to `repo`, or nil when git can't say (no git, not a repo, an error).
    static func list(_ repo: String) -> Set<String>? {
        guard let git else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: git)
        process.arguments = ["-C", repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard"]
        // Reading only: never wait for, or take, the repo's lock (an editor's git may be busy in it).
        process.environment = ["GIT_OPTIONAL_LOCKS": "0", "PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory()]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        return Set(data.split(separator: 0).compactMap { String(data: Data($0), encoding: .utf8) })
    }
}
