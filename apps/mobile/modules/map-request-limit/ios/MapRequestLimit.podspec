Pod::Spec.new do |s|
  s.name           = 'MapRequestLimit'
  s.version        = '1.0.0'
  s.summary        = 'Limita as requisições simultâneas do MapLibre aos servidores de tiles.'
  s.description    = s.summary
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Wayboo'
  s.homepage       = 'https://github.com/caiorg/wayboo'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/caiorg/wayboo.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
