import Foundation

/**
 Deixa no máximo `maxInFlight` requisições em andamento para os hosts de `hosts`.

 O MapLibre faz até 20 requisições simultâneas e não deixa mudar esse número no iOS. Os termos do OpenFreeMap
 (https://openfreemap.org/tos/) limitam downloads offline a 4 requisições paralelas. Como o servidor fala HTTP/2,
 `HTTPMaximumConnectionsPerHost` não basta: várias requisições dividem uma conexão. Este protocolo segura as
 excedentes numa fila e repassa cada uma a uma sessão própria quando abre vaga.
 */
final class ThrottledURLProtocol: URLProtocol {
  static var hosts: Set<String> = ["tiles.openfreemap.org"]
  static let maxInFlight = 4

  private static let handledKey = "WaybooThrottledURLProtocol"
  static let gate = RequestGate(limit: maxInFlight)

  /// Sessão que faz o pedido de verdade. Sem este protocolo, para não entrar na fila de novo.
  private static let session: URLSession = {
    let config = URLSessionConfiguration.default
    config.protocolClasses = (config.protocolClasses ?? []).filter { $0 != ThrottledURLProtocol.self }
    // Mesmo comportamento da sessão padrão do MapLibre: o cache é dele, não do sistema.
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.urlCache = nil
    return URLSession(configuration: config)
  }()

  private let stateLock = NSLock()
  private var stopped = false
  private var innerTask: URLSessionDataTask?

  override class func canInit(with request: URLRequest) -> Bool {
    guard let host = request.url?.host?.lowercased(), hosts.contains(host) else { return false }
    return URLProtocol.property(forKey: handledKey, in: request) == nil
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

  override func startLoading() {
    Self.gate.enter(self) { [weak self] in
      guard let self else {
        Self.gate.leave()
        return
      }
      self.begin()
    }
  }

  override func stopLoading() {
    stateLock.lock()
    stopped = true
    let running = innerTask
    stateLock.unlock()
    if Self.gate.cancel(self) { return }
    // A vaga volta no fim da tarefa cancelada, no handler de `begin`.
    running?.cancel()
  }

  private func begin() {
    guard let copy = (request as NSURLRequest).mutableCopy() as? NSMutableURLRequest else {
      Self.gate.leave()
      return
    }
    URLProtocol.setProperty(true, forKey: Self.handledKey, in: copy)
    let inner = Self.session.dataTask(with: copy as URLRequest) { [weak self] data, response, error in
      Self.gate.leave()
      self?.deliver(data: data, response: response, error: error)
    }
    stateLock.lock()
    if stopped {
      stateLock.unlock()
      Self.gate.leave()
      return
    }
    innerTask = inner
    stateLock.unlock()
    inner.resume()
  }

  private func deliver(data: Data?, response: URLResponse?, error: Error?) {
    stateLock.lock()
    let wasStopped = stopped
    stateLock.unlock()
    guard !wasStopped, let client else { return }
    if let error {
      client.urlProtocol(self, didFailWithError: error)
      return
    }
    if let response {
      client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    }
    if let data {
      client.urlProtocol(self, didLoad: data)
    }
    client.urlProtocolDidFinishLoading(self)
  }
}
