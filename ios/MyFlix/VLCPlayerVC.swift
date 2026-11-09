import AVFoundation
import MobileVLCKit
import UIKit

/// Playback for files Apple's player can't open (MKV, AVI, DTS/TrueHD/FLAC audio, MPEG-2/4, PGS subtitles).
/// Plays the original file straight from Jellyfin with libVLC: nothing is converted on the server.
final class VLCPlayerVC: UIViewController, VLCMediaPlayerDelegate {
    private let info: PlayInfo
    private let profileId: String
    private let player = VLCMediaPlayer()
    private var mediaURL: URL?
    private var proxied: URL?

    private let videoView = UIView()
    private let overlay = UIView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let titleLabel = UILabel()
    private let closeButton = UIButton(type: .system)
    private let playButton = UIButton(type: .system)
    private let backButton = UIButton(type: .system)
    private let fwdButton = UIButton(type: .system)
    private let audioButton = UIButton(type: .system)
    private let subsButton = UIButton(type: .system)
    private let slider = UISlider()
    private let elapsed = UILabel()
    private let remaining = UILabel()

    private var scrubbing = false
    private var didResume = false
    private var reportedStart = false
    private var stopped = false
    private var lastReport = Date.distantPast
    private var hideTimer: Timer?
    private var tracksKey = ""

    init(info: PlayInfo, profileId: String) {
        self.info = info
        self.profileId = profileId
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .allButUpsideDown }
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    // MARK: Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        buildUI()
        spinner.startAnimating()
        Task { await load() }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || presentingViewController == nil { teardown() }
    }

    private func load() async {
        let direct = info.base + info.streamPath + "&api_key=" + info.token
        guard let url = URL(string: direct) else { return fail("Couldn't start playback.") }
        let headers = Net.shared.cfHeaders(for: direct)
        if !headers.isEmpty {
            // libVLC can't send custom headers, so go through the loopback proxy that adds them.
            let p = await Task.detached { AuthProxy.shared.proxied(url, headers: headers) }.value
            guard let p else { return fail("Couldn't start playback.") }
            proxied = p
            mediaURL = p
        } else {
            mediaURL = url
        }
        await MainActor.run { self.begin() }
    }

    private func begin() {
        guard let url = mediaURL else { return }
        let media = VLCMedia(url: url)
        media.addOptions(["network-caching": 4000, "file-caching": 4000])
        player.delegate = self
        player.drawable = videoView
        player.media = media
        player.play()
    }

    private func teardown(report: Bool = true) {
        if report && !stopped { reportProgress("stop") }
        stopped = true
        hideTimer?.invalidate()
        player.delegate = nil
        player.stop()
        player.drawable = nil
        if let p = proxied { AuthProxy.shared.forget(p); proxied = nil }
        UIApplication.shared.isIdleTimerDisabled = false
    }

    // MARK: VLC delegate

    func mediaPlayerStateChanged(_ aNotification: Notification) {
        DispatchQueue.main.async { [self] in
            guard !stopped else { return }
            switch player.state {
            case .opening, .buffering:
                if !player.isPlaying { spinner.startAnimating() }
            case .playing:
                spinner.stopAnimating()
                playButton.setImage(symbol("pause.fill", 34), for: .normal)
                if !didResume {
                    didResume = true
                    player.currentVideoSubTitleIndex = -1          // subtitles off until chosen
                    if info.startMs > 0 { player.time = VLCTime(int: Int32(info.startMs)) }
                }
                if !reportedStart { reportProgress("start") }
                refreshTracks()
            case .paused:
                spinner.stopAnimating()
                playButton.setImage(symbol("play.fill", 34), for: .normal)
                reportProgress("progress")
            case .ended:
                finished()
            case .error:
                fail("This title couldn't be played on this device.")
            default: break
            }
        }
    }

    func mediaPlayerTimeChanged(_ aNotification: Notification) {
        DispatchQueue.main.async { [self] in
            guard !stopped else { return }
            let t = Int(player.time.intValue)
            let len = max(Int(player.media?.length.intValue ?? 0), info.runtimeMs)
            if !scrubbing, len > 0 { slider.value = Float(t) / Float(len) }
            elapsed.text = clock(t)
            remaining.text = "-" + clock(max(0, len - t))
            if Date().timeIntervalSince(lastReport) > 10 { reportProgress("progress") }
        }
    }

    // MARK: Reporting

    private func reportProgress(_ kind: String) {
        guard !stopped || kind == "stop" else { return }
        if kind != "start" && !reportedStart { return }
        lastReport = Date()
        var body: [String: Any] = [
            "ItemId": info.itemId, "MediaSourceId": info.mediaSourceId, "PlaySessionId": info.playSessionId,
            "PositionTicks": Int(player.time.intValue) * 10_000, "IsPaused": !player.isPlaying, "CanSeek": true,
            "PlayMethod": "DirectPlay",
        ]
        let path: String
        switch kind {
        case "start": path = "/Sessions/Playing"; reportedStart = true
        case "stop": path = "/Sessions/Playing/Stopped"
        default: path = "/Sessions/Playing/Progress"; body["EventName"] = "TimeUpdate"
        }
        let base = info.base, token = info.token
        Task { await Net.shared.postJellyfin(base: base, path: path, token: token, json: body) }
    }

    private func finished() {
        let next = info.next
        let pid = profileId
        if let n = next {
            // Count this one as watched, then roll into the next episode (it picks its own player).
            let ticks = max(Int(player.media?.length.intValue ?? 0), info.runtimeMs) * 10_000
            let body: [String: Any] = ["ItemId": info.itemId, "MediaSourceId": info.mediaSourceId,
                                       "PlaySessionId": info.playSessionId, "PositionTicks": ticks]
            let base = info.base, token = info.token
            Task { await Net.shared.postJellyfin(base: base, path: "/Sessions/Playing/Stopped", token: token, json: body) }
            teardown(report: false)
            let presenter = presentingViewController
            dismiss(animated: false) {
                let p = PlayerVC(itemId: n, profileId: pid)
                p.modalPresentationStyle = .fullScreen
                presenter?.present(p, animated: false)
            }
        } else {
            teardown()
            dismiss(animated: true)
        }
    }

    private func fail(_ msg: String) {
        DispatchQueue.main.async { [self] in
            spinner.stopAnimating()
            teardown(report: false)
            let a = UIAlertController(title: nil, message: msg, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in self?.dismiss(animated: true) })
            present(a, animated: true)
        }
    }

    // MARK: Controls

    private func buildUI() {
        videoView.frame = view.bounds
        videoView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(videoView)
        overlay.frame = view.bounds
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        overlay.backgroundColor = UIColor.black.withAlphaComponent(0.35)
        view.addSubview(overlay)
        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(toggleOverlay)))

        var t = info.name ?? ""
        if let s = info.seriesName {
            t = s + (info.season != nil && info.episode != nil ? " · S\(info.season!):E\(info.episode!)" : "") + "  " + t
        }
        titleLabel.text = t
        titleLabel.textColor = .white
        titleLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        titleLabel.numberOfLines = 1

        closeButton.setImage(symbol("xmark", 20), for: .normal)
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        playButton.setImage(symbol("pause.fill", 34), for: .normal)
        playButton.addTarget(self, action: #selector(togglePlay), for: .touchUpInside)
        backButton.setImage(symbol("gobackward.10", 30), for: .normal)
        backButton.addTarget(self, action: #selector(skipBack), for: .touchUpInside)
        fwdButton.setImage(symbol("goforward.10", 30), for: .normal)
        fwdButton.addTarget(self, action: #selector(skipFwd), for: .touchUpInside)
        audioButton.setImage(symbol("speaker.wave.2", 22), for: .normal)
        subsButton.setImage(symbol("captions.bubble", 22), for: .normal)
        for b in [closeButton, playButton, backButton, fwdButton, audioButton, subsButton] { b.tintColor = .white }
        audioButton.showsMenuAsPrimaryAction = true
        subsButton.showsMenuAsPrimaryAction = true

        slider.minimumTrackTintColor = .white
        slider.addTarget(self, action: #selector(scrubStart), for: .touchDown)
        slider.addTarget(self, action: #selector(scrubEnd), for: [.touchUpInside, .touchUpOutside, .touchCancel])
        for l in [elapsed, remaining] {
            l.textColor = .white
            l.font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular)
            l.text = "0:00"
        }

        let top = UIStackView(arrangedSubviews: [closeButton, titleLabel, UIView()])
        top.spacing = 14; top.alignment = .center
        let mid = UIStackView(arrangedSubviews: [backButton, playButton, fwdButton])
        mid.spacing = 48; mid.alignment = .center
        let bar = UIStackView(arrangedSubviews: [elapsed, slider, remaining, subsButton, audioButton])
        bar.spacing = 12; bar.alignment = .center
        for s in [top, mid, bar] { s.translatesAutoresizingMaskIntoConstraints = false; overlay.addSubview(s) }
        spinner.color = .white
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)
        let g = overlay.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            top.topAnchor.constraint(equalTo: g.topAnchor, constant: 14),
            top.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 20),
            top.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -20),
            mid.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            mid.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
            bar.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -16),
            bar.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 20),
            bar.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -20),
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        scheduleHide()
    }

    private func symbol(_ name: String, _ size: CGFloat) -> UIImage? {
        UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: .semibold))
    }

    private func clock(_ ms: Int) -> String {
        let s = max(0, ms / 1000)
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }

    @objc private func toggleOverlay() {
        let show = overlay.alpha < 0.5
        UIView.animate(withDuration: 0.2) { self.overlay.alpha = show ? 1 : 0 }
        if show { scheduleHide() }
    }

    private func scheduleHide() {
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in
            guard let self, self.player.isPlaying, !self.scrubbing else { return }
            UIView.animate(withDuration: 0.3) { self.overlay.alpha = 0 }
        }
    }

    @objc private func closeTapped() { teardown(); dismiss(animated: true) }
    @objc private func togglePlay() { player.isPlaying ? player.pause() : player.play(); scheduleHide() }
    @objc private func skipBack() { player.jumpBackward(10); scheduleHide() }
    @objc private func skipFwd() { player.jumpForward(10); scheduleHide() }
    @objc private func scrubStart() { scrubbing = true; hideTimer?.invalidate() }
    @objc private func scrubEnd() {
        let len = max(Int(player.media?.length.intValue ?? 0), info.runtimeMs)
        if len > 0 { player.time = VLCTime(int: Int32(Float(len) * slider.value)) }
        scrubbing = false
        scheduleHide()
    }

    // MARK: Audio / subtitle pickers

    private func refreshTracks() {
        let aNames = (player.audioTrackNames as? [String]) ?? []
        let aIdx = (player.audioTrackIndexes as? [NSNumber])?.map { $0.int32Value } ?? []
        let sNames = (player.videoSubTitlesNames as? [String]) ?? []
        let sIdx = (player.videoSubTitlesIndexes as? [NSNumber])?.map { $0.int32Value } ?? []
        let key = "\(aNames)\(sNames)"
        guard key != tracksKey, !aNames.isEmpty || !sNames.isEmpty else { return }
        tracksKey = key

        let audioItems = zip(aNames, aIdx).filter { $0.1 >= 0 }.map { name, idx in
            UIAction(title: name, state: idx == self.player.currentAudioTrackIndex ? .on : .off) { [weak self] _ in
                self?.player.currentAudioTrackIndex = idx
                self?.tracksKey = ""
                self?.refreshTracks()
            }
        }
        audioButton.menu = UIMenu(title: "Audio", children: audioItems)
        audioButton.isHidden = audioItems.count < 2

        let subItems = zip(sNames, sIdx).map { name, idx -> UIAction in
            let title = idx < 0 ? "Off" : name
            return UIAction(title: title, state: idx == self.player.currentVideoSubTitleIndex ? .on : .off) { [weak self] _ in
                self?.player.currentVideoSubTitleIndex = idx
                self?.tracksKey = ""
                self?.refreshTracks()
            }
        }
        subsButton.menu = UIMenu(title: "Subtitles", children: subItems)
        subsButton.isHidden = sNames.count < 2
    }
}
