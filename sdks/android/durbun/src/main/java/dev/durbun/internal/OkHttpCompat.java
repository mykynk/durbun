package dev.durbun.internal;

import okhttp3.MediaType;
import okhttp3.ResponseBody;

/**
 * Calls OkHttp's static factories from Java so the compiled SDK links against every OkHttp the app may
 * ship (3.12 … 5.x). Kotlin would route these calls through OkHttp 4's companion objects, which OkHttp 3
 * does not have; the plain static methods exist in all versions.
 */
final class OkHttpCompat {
    private OkHttpCompat() {
    }

    static MediaType mediaType(String value) {
        if (value == null) return null;
        try {
            return MediaType.parse(value);
        } catch (RuntimeException e) {
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    static ResponseBody responseBody(MediaType type, byte[] content) {
        return ResponseBody.create(type, content);
    }
}
