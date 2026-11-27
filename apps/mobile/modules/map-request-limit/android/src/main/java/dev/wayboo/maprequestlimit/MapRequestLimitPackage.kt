package dev.wayboo.maprequestlimit

import android.app.Application
import android.content.Context
import android.util.Log
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package
import okhttp3.Call
import okhttp3.Dispatcher
import okhttp3.OkHttpClient

/**
 * Limita a 4 as requisições simultâneas do MapLibre por servidor. O padrão dele é 20, e os termos do OpenFreeMap
 * (https://openfreemap.org/tos/) permitem no máximo 4 em downloads offline. O `Dispatcher` do OkHttp conta
 * requisições, não conexões, então o limite vale também com HTTP/2.
 *
 * O `MLRNTransformRequestModule` da lib do mapa troca o client se o app usar `addUrlTransform`. O Wayboo não usa.
 */
class MapRequestLimitPackage : Package {
  override fun createApplicationLifecycleListeners(context: Context): List<ApplicationLifecycleListener> =
    listOf(object : ApplicationLifecycleListener {
      override fun onCreate(application: Application) = install()
    })

  private fun install() {
    val dispatcher = Dispatcher().apply { maxRequestsPerHost = MAX_REQUESTS_PER_HOST }
    val client = OkHttpClient.Builder().dispatcher(dispatcher).build()
    try {
      // Reflexão: a lib do mapa traz o SDK do MapLibre como `implementation`, fora do classpath deste módulo.
      Class.forName("org.maplibre.android.module.http.HttpRequestUtil")
        .getMethod("setOkHttpClient", Call.Factory::class.java)
        .invoke(null, client)
    } catch (e: ReflectiveOperationException) {
      Log.w(TAG, "HttpRequestUtil indisponível; limite de requisições desligado", e)
    }
  }

  private companion object {
    const val TAG = "MapRequestLimit"
    const val MAX_REQUESTS_PER_HOST = 4
  }
}
