import Foundation

/// Fila com no máximo `limit` trabalhos em execução. Quem chega com as vagas ocupadas espera na ordem de chegada.
final class RequestGate {
  private let limit: Int
  private let lock = NSLock()
  private var running = 0
  private var waiting: [(owner: ObjectIdentifier, start: () -> Void)] = []

  init(limit: Int) {
    self.limit = limit
  }

  /// Roda `start` agora, se houver vaga, ou quando uma vaga abrir. Cada `start` executado deve terminar com um `leave()`.
  func enter(_ owner: AnyObject, _ start: @escaping () -> Void) {
    lock.lock()
    if running < limit {
      running += 1
      lock.unlock()
      start()
      return
    }
    waiting.append((ObjectIdentifier(owner), start))
    lock.unlock()
  }

  /// Devolve a vaga de um trabalho que terminou. Se alguém espera, a vaga passa direto para ele.
  func leave() {
    lock.lock()
    if waiting.isEmpty {
      running = max(0, running - 1)
      lock.unlock()
      return
    }
    let next = waiting.removeFirst()
    lock.unlock()
    next.start()
  }

  /// Tira da fila um trabalho que ainda não começou. Devolve false se ele já estava rodando (ou nunca entrou).
  @discardableResult
  func cancel(_ owner: AnyObject) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard let i = waiting.firstIndex(where: { $0.owner == ObjectIdentifier(owner) }) else { return false }
    waiting.remove(at: i)
    return true
  }

  var snapshot: (running: Int, waiting: Int) {
    lock.lock()
    defer { lock.unlock() }
    return (running, waiting.count)
  }
}
