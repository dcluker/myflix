import SwiftUI

struct PairView: View {
    @ObservedObject var state: AppState
    @State private var code = ""
    @State private var label = UIDevice.current.name
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Bool

    private var formatted: String {
        PairCode.format(String(code.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(8)))
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                Text("MYFLIX")
                    .font(.system(size: 44, weight: .black))
                    .tracking(6)
                    .foregroundColor(Color(red: 0.9, green: 0.04, blue: 0.08))
                    .padding(.top, 60)
                Text("Enter the 8-character code from your invite.")
                    .foregroundColor(.white.opacity(0.8))
                    .multilineTextAlignment(.center)

                TextField("XXXX-XXXX", text: Binding(get: { formatted }, set: { code = $0 }))
                    .font(.system(size: 34, weight: .bold, design: .monospaced))
                    .multilineTextAlignment(.center)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .focused($focus)
                    .padding(14)
                    .background(Color.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                    .frame(maxWidth: 360)

                VStack(alignment: .leading, spacing: 6) {
                    Text("Name this device").font(.footnote).foregroundColor(.white.opacity(0.6))
                    TextField("Device name", text: $label)
                        .padding(12)
                        .background(Color.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                }
                .frame(maxWidth: 360)

                if let error {
                    Text(error).foregroundColor(Color(red: 1, green: 0.45, blue: 0.45)).multilineTextAlignment(.center)
                }

                Button(action: connect) {
                    HStack {
                        if busy { ProgressView().tint(.black) }
                        Text(busy ? "Connecting…" : "Connect").fontWeight(.bold)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 10))
                    .foregroundColor(.black)
                }
                .frame(maxWidth: 360)
                .disabled(busy || PairCode.normalize(code) == nil)
                .opacity(PairCode.normalize(code) == nil ? 0.5 : 1)
            }
            .padding(24)
            .frame(maxWidth: .infinity)
        }
        .onAppear { focus = true }
    }

    private func connect() {
        busy = true
        error = nil
        focus = false
        Task {
            let r = await PairClient.pair(rawCode: code, label: label)
            await MainActor.run {
                busy = false
                if case .success(let c) = r { state.paired(c) } else { error = r.message }
            }
        }
    }
}
