import AVKit
import UIKit

struct PlayInfo {
    var itemId: String, name: String?, seriesName: String?, season: Int?, episode: Int?
    var runtimeMs: Int, startMs: Int
    var base: String, token: String, userId: String
    var mediaSourceId: String, playSessionId: String, streamPath: String
    var next: String?
    var container: String?, videoCodec: String?, audioCodec: String?
    /// Live channel: `streamUrl` is absolute. `direct` = the public source HLS (not Jellyfin), so no Jellyfin headers go with it.
    var live = false, direct = false, streamUrl = "", liveStreamId = ""
    init(_ j: [String: Any]) {
        live = j["live"] as? Bool ?? false
        direct = j["direct"] as? Bool ?? false
        streamUrl = j["streamUrl"] as? String ?? ""
        liveStreamId = j["liveStreamId"] as? String ?? ""
        itemId = j["itemId"] as? String ?? ""
        name = j["name"] as? String
        seriesName = j["seriesName"] as? String
        season = j["season"] as? Int
        episode = j["episode"] as? Int
        runtimeMs = j["runtimeMs"] as? Int ?? 0
        startMs = j["startPositionMs"] as? Int ?? 0
        base = (j["publicBase"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (j["jellyfinBase"] as? String) ?? Config.publicJellyfin
        token = j["token"] as? String ?? ""
        userId = j["userId"] as? String ?? ""
        mediaSourceId = j["mediaSourceId"] as? String ?? ""
        playSessionId = j["playSessionId"] as? String ?? ""
        streamPath = j["streamPath"] as? String ?? ""
        next = j["nextEpisodeId"] as? String
        container = j["container"] as? String
        videoCodec = j["videoCodec"] as? String
        audioCodec = j["audioCodec"] as? String
    }
}

extension PlayInfo {
    /// True only when no Apple path can play the file. MKV and DTS/TrueHD/FLAC audio are fine: Jellyfin repackages
    /// the container and converts the audio to HLS while the video is copied. Only video Apple can't decode
    /// (MPEG-2/4, VC-1, AV1 ...) goes to libVLC.
    var needsVLC: Bool {
        if live { return false }   // live channels are HLS: AVPlayer plays them as is
        guard let v = videoCodec?.lowercased() else { return false }
        return !["h264", "hevc"].contains(v)
    }
}

/// Native playback. Jellyfin is asked (with an iOS device profile) for a direct stream when the file is
/// already iPhone-friendly, otherwise an HLS stream where it copies the video and only converts audio
/// the device can't decode. Progress is reported back so Continue Watching stays in sync.
final class PlayerVC: AVPlayerViewController {
    private let profileId: String
    private let live: Bool
    private var itemId: String
    private var info: PlayInfo?
    private var proxiedURL: URL?
    private var triedVLC = false
    private var timeObserver: Any?
    private var statusObs: NSKeyValueObservation?
    private var endObs: NSObjectProtocol?
    private var reportedStart = false
    private var stopped = false
    private let spinner = UIActivityIndicatorView(style: .large)

    init(itemId: String, profileId: String, live: Bool = false) {
        self.itemId = itemId
        self.profileId = profileId
        self.live = live
        super.init(nibName: nil, bundle: nil)
        allowsPictureInPicturePlayback = true
        canStartPictureInPictureAutomaticallyFromInline = true
        entersFullScreenWhenPlaybackBegins = false
        updatesNowPlayingInfoCenter = true
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        spinner.color = .white
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)
        NSLayoutConstraint.activate([spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor), spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
        spinner.startAnimating()
        Task { await start(itemId) }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || presentingViewController == nil { teardown() }
    }

    // MARK: Loading

    private func start(_ id: String) async {
        do {
            let j = try await Net.shared.fetchPlayInfo(itemId: id, profileUserId: profileId, live: live)
            let i = PlayInfo(j)
            guard !i.itemId.isEmpty, !i.token.isEmpty else { throw URLError(.cannotParseResponse) }
            if i.live {   // a live channel: the URL is ready to play, there is nothing to resolve or report
                guard let u = URL(string: i.streamUrl) else { throw URLError(.badURL) }
                await MainActor.run { self.begin(i, u) }
                return
            }
            if i.needsVLC {
                await MainActor.run { self.handOffToVLC(i) }
                return
            }
            let url = await resolveURL(i)
            await MainActor.run { self.begin(i, url) }
        } catch let e as PlayInfoError {
            await MainActor.run { self.fail(e.message) }
        } catch {
            await MainActor.run { self.fail("Couldn't start playback. Check your connection and try again.") }
        }
    }

    /// Apple's player can't open this file (MKV, DTS, ...): swap in the libVLC player and play the original.
    private func handOffToVLC(_ i: PlayInfo) {
        teardown(reportStop: false)
        let vlc = VLCPlayerVC(info: i, profileId: profileId)
        vlc.modalPresentationStyle = .fullScreen
        if let presenter = presentingViewController {
            dismiss(animated: false) { presenter.present(vlc, animated: false) }
        } else {
            present(vlc, animated: false)
        }
    }

    /// Ask Jellyfin what this device can play. Falls back to the raw file stream if the call fails.
    private func resolveURL(_ i: PlayInfo) async -> URL {
        let direct = i.base + i.streamPath + "&api_key=" + i.token
        let profile: [String: Any] = [
            "MaxStreamingBitrate": 15_000_000,
            "DirectPlayProfiles": [["Container": "mp4,m4v,mov", "Type": "Video",
                                    "VideoCodec": "h264,hevc", "AudioCodec": "aac,ac3,eac3,mp3,alac"]],
            "TranscodingProfiles": [["Container": "mp4", "Type": "Video", "VideoCodec": "h264,hevc",
                                     "AudioCodec": "aac,ac3,eac3", "Protocol": "hls", "Context": "Streaming",
                                     "MaxAudioChannels": "6", "MinSegments": "2", "BreakOnNonKeyFrames": true]],
            "SubtitleProfiles": [["Format": "vtt", "Method": "Hls"], ["Format": "vtt", "Method": "External"]],
        ]
        let q = "UserId=\(i.userId)&MaxStreamingBitrate=15000000&AutoOpenLiveStream=false&MediaSourceId=\(i.mediaSourceId)"
        guard let body = try? JSONSerialization.data(withJSONObject: ["DeviceProfile": profile]),
              let r = Net.shared.request(i.base + "/Items/\(i.itemId)/PlaybackInfo?" + q, method: "POST", body: body,
                                         headers: ["Authorization": Net.shared.jellyfinAuth(token: i.token)]),
              let (data, _) = try? await Net.shared.session.data(for: r),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let src = (j["MediaSources"] as? [[String: Any]])?.first else { return URL(string: direct)! }
        if src["SupportsDirectPlay"] as? Bool == true || src["SupportsDirectStream"] as? Bool == true,
           (src["TranscodingUrl"] as? String) == nil, let u = URL(string: direct) { return u }
        if let t = src["TranscodingUrl"] as? String {
            var full = t.hasPrefix("http") ? t : i.base + (t.hasPrefix("/") ? t : "/" + t)
            if !full.contains("api_key=") && !full.lowercased().contains("apikey=") { full += (full.contains("?") ? "&" : "?") + "api_key=" + i.token }
            if let u = URL(string: full) { return u }
        }
        return URL(string: direct)!
    }

    private func begin(_ i: PlayInfo, _ url: URL) {
        teardown(reportStop: false)
        stopped = false
        reportedStart = false
        info = i
        // Apple's media stack doesn't reliably send custom headers on its own requests, which is what the
        // Cloudflare Access service token needs: go through the loopback proxy that adds them.
        // A direct live stream lives on someone else's CDN: never send it the Jellyfin token.
        var headers: [String: String] = i.direct ? [:] : ["Authorization": Net.shared.jellyfinAuth(token: i.token)]
        var playURL = url
        let cf = Net.shared.cfHeaders(for: url.absoluteString)
        if !cf.isEmpty {
            if let p = AuthProxy.shared.proxied(url, headers: cf.merging(headers) { a, _ in a }) { playURL = p; headers = [:] }
            else { headers.merge(cf) { a, _ in a } }
        }
        proxiedURL = playURL == url ? nil : playURL
        let asset = AVURLAsset(url: playURL, options: headers.isEmpty ? nil : ["AVURLAssetHTTPHeaderFieldsOptionKey": headers])
        let item = AVPlayerItem(asset: asset)
        item.externalMetadata = metadata(i)
        let p = AVPlayer(playerItem: item)
        p.allowsExternalPlayback = true
        player = p

        statusObs = item.observe(\.status) { [weak self] it, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                switch it.status {
                case .readyToPlay:
                    self.spinner.stopAnimating()
                    if i.startMs > 0 {
                        p.seek(to: CMTime(value: CMTimeValue(i.startMs), timescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero) { _ in
                            p.play(); self.report("start")
                        }
                    } else { p.play(); self.report("start") }
                case .failed:
                    if i.live { self.fail("This channel isn't streaming right now. Try another one.") }
                    else if !self.triedVLC { self.triedVLC = true; self.handOffToVLC(i) }   // last resort before giving up
                    else { self.fail("This title couldn't be played on this device.") }
                default: break
                }
            }
        }
        timeObserver = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 10, preferredTimescale: 1), queue: .main) { [weak self] _ in
            self?.report("progress")
        }
        endObs = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            self?.finished()
        }
    }

    private func metadata(_ i: PlayInfo) -> [AVMetadataItem] {
        func item(_ id: AVMetadataIdentifier, _ v: String) -> AVMetadataItem {
            let m = AVMutableMetadataItem()
            m.identifier = id
            m.value = v as NSString
            m.extendedLanguageTag = "und"
            return m
        }
        var out: [AVMetadataItem] = []
        if let n = i.name { out.append(item(.commonIdentifierTitle, n)) }
        if let s = i.seriesName {
            var sub = s
            if let se = i.season, let ep = i.episode { sub += " · S\(se):E\(ep)" }
            out.append(item(.iTunesMetadataTrackSubTitle, sub))
        }
        return out
    }

    // MARK: Reporting

    private func report(_ kind: String) {
        guard let i = info, !i.live, !stopped, let p = player else { return }
        let secs = p.currentTime().seconds
        guard secs.isFinite else { return }
        var body: [String: Any] = [
            "ItemId": i.itemId, "MediaSourceId": i.mediaSourceId, "PlaySessionId": i.playSessionId,
            "PositionTicks": Int(secs * 10_000_000), "IsPaused": p.rate == 0, "CanSeek": true,
            "PlayMethod": "Transcode",
        ]
        let path: String
        if kind == "start" { path = "/Sessions/Playing"; reportedStart = true }
        else if kind == "stop" { path = "/Sessions/Playing/Stopped" }
        else { path = "/Sessions/Playing/Progress"; body["EventName"] = "TimeUpdate" }
        if kind != "start" && !reportedStart { return }
        Task { await Net.shared.postJellyfin(base: i.base, path: path, token: i.token, json: body) }
    }

    private func teardown(reportStop: Bool = true) {
        if let i = info, i.live, !stopped, !i.liveStreamId.isEmpty {   // transcoded channel: release Jellyfin's live stream
            let ls = i.liveStreamId, pid = profileId
            Task { await Net.shared.stopLive(liveStreamId: ls, profileUserId: pid) }
        }
        if reportStop && !stopped { report("stop") }
        stopped = true
        if let o = timeObserver { player?.removeTimeObserver(o); timeObserver = nil }
        statusObs?.invalidate(); statusObs = nil
        if let e = endObs { NotificationCenter.default.removeObserver(e); endObs = nil }
        player?.pause()
        if let u = proxiedURL { AuthProxy.shared.forget(u); proxiedURL = nil }
    }

    private func finished() {
        if !live, let n = info?.next {
            // Count this one as watched and roll straight into the next episode.
            if let i = info, let p = player {
                let ticks = Int(p.currentTime().seconds * 10_000_000)
                Task { await Net.shared.postJellyfin(base: i.base, path: "/Sessions/Playing/Stopped", token: i.token,
                                                     json: ["ItemId": i.itemId, "MediaSourceId": i.mediaSourceId, "PlaySessionId": i.playSessionId, "PositionTicks": ticks]) }
            }
            teardown(reportStop: false)
            spinner.startAnimating()
            Task { await start(n) }
        } else {
            teardown()
            dismiss(animated: true)
        }
    }

    private func fail(_ msg: String) {
        spinner.stopAnimating()
        teardown(reportStop: false)
        let a = UIAlertController(title: nil, message: msg, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in self?.dismiss(animated: true) })
        present(a, animated: true)
    }
}
