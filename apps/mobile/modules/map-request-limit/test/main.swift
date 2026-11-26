// Teste do limite de requisições no iOS, sem aparelho (macOS com Swift):
//   python3 test/slow_server.py 18765 &
//   swiftc -o /tmp/throttle ios/RequestGate.swift ios/ThrottledURLProtocol.swift test/main.swift && /tmp/throttle 18765

import Foundation

func check(_ ok: Bool, _ msg: String) { if !ok { print("FALHOU: \(msg)"); exit(1) } else { print("ok: \(msg)") } }

// RequestGate
do {
  let gate = RequestGate(limit: 2)
  var started: [Int] = []
  let owners = (0..<4).map { _ in NSObject() }
  for (i, o) in owners.enumerated() { gate.enter(o) { started.append(i) } }
  check(started == [0, 1] && gate.snapshot == (2, 2), "só 2 começam, 2 esperam")
  check(gate.cancel(owners[2]), "cancela quem espera")
  check(!gate.cancel(owners[0]), "não cancela quem roda")
  gate.leave()
  check(started == [0, 1, 3] && gate.snapshot == (2, 0), "vaga passa para o próximo da fila")
  gate.leave(); gate.leave()
  check(gate.snapshot == (0, 0), "vagas voltam")
}

// Protocolo: 20 pedidos simultâneos, no máximo 4 em voo no servidor.
let port = CommandLine.arguments[1]
ThrottledURLProtocol.hosts = ["127.0.0.1"]
let config = URLSessionConfiguration.default
config.protocolClasses = [ThrottledURLProtocol.self] + (config.protocolClasses ?? [])
config.httpMaximumConnectionsPerHost = 20
let session = URLSession(configuration: config)
let group = DispatchGroup()
let lock = NSLock()
var oks = 0
var agents: Set<String> = []
for i in 0..<20 {
  group.enter()
  var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/t/\(i)")!)
  req.setValue("Wayboo/teste", forHTTPHeaderField: "User-Agent")
  session.dataTask(with: req) { data, resp, err in
    lock.lock()
    if err == nil, (resp as? HTTPURLResponse)?.statusCode == 200 { oks += 1 }
    if let data { agents.insert(String(decoding: data, as: UTF8.self)) }
    lock.unlock()
    group.leave()
  }.resume()
}
// Cancelar um pedido que está na fila não pode prender a vaga.
group.enter()
let cancelled = session.dataTask(with: URL(string: "http://127.0.0.1:\(port)/cancel")!) { _, _, err in
  check((err as? URLError)?.code == .cancelled, "pedido cancelado termina com cancelled")
  group.leave()
}
cancelled.resume()
DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { cancelled.cancel() }
check(group.wait(timeout: .now() + 30) == .success, "todos terminam")
check(oks == 20, "20 respostas 200 (\(oks))")
check(agents == ["Wayboo/teste"], "User-Agent preservado (\(agents))")
let peak = try! String(contentsOf: URL(string: "http://127.0.0.1:\(port)/peak")!, encoding: .utf8)
check(Int(peak)! <= 4, "pico no servidor \(peak) <= 4")
check(ThrottledURLProtocol.gate.snapshot == (0, 0), "nenhuma vaga presa \(ThrottledURLProtocol.gate.snapshot)")
print("tudo ok")
