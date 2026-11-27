import Foundation

enum MapNetworkLimit {
  /**
   Põe o `ThrottledURLProtocol` na sessão de rede do MapLibre. Precisa rodar antes do primeiro mapa, que cria a sessão.
   Usa o runtime do Objective-C para não depender do módulo `MapLibre` na compilação: a lib do mapa o traz pelo SPM.
   */
  static func install() {
    guard let cls = NSClassFromString("MLNNetworkConfiguration") else {
      NSLog("[MapRequestLimit] MLNNetworkConfiguration não encontrada; limite de requisições desligado")
      return
    }
    let shared = NSSelectorFromString("sharedManager")
    guard (cls as AnyObject).responds(to: shared),
      let manager = (cls as AnyObject).perform(shared)?.takeUnretainedValue() as? NSObject,
      let current = manager.value(forKey: "sessionConfiguration") as? URLSessionConfiguration,
      let config = current.copy() as? URLSessionConfiguration
    else {
      NSLog("[MapRequestLimit] sessionConfiguration indisponível; limite de requisições desligado")
      return
    }
    config.protocolClasses = [ThrottledURLProtocol.self] + (config.protocolClasses ?? [])
    manager.setValue(config, forKey: "sessionConfiguration")
  }
}
