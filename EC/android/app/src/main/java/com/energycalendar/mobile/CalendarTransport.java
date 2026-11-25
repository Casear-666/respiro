package com.energycalendar.mobile;

import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONException;

final class CalendarTransport {
    private static final Pattern SESSION_COOKIE =
        Pattern.compile("^calendar_session=([a-zA-Z0-9_-]+)(?:;|$)");
    private static final int MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

    static final class HttpError extends IOException {
        final int status;

        HttpError(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    static final class Response {
        final JSObject data;
        final String cookie;

        Response(JSObject data, String cookie) {
            this.data = data;
            this.cookie = cookie;
        }
    }

    static String origin(String value, boolean debug) {
        final URI uri;
        try {
            uri = URI.create(value == null ? "" : value);
        } catch (IllegalArgumentException invalid) {
            throw new IllegalArgumentException("服务器地址格式不正确");
        }
        String host = uri.getHost();
        String scheme = uri.getScheme();
        boolean https = "https".equalsIgnoreCase(scheme);
        if (host == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null ||
            uri.getRawFragment() != null || uri.getPort() > 65535 ||
            (!uri.getRawPath().isEmpty() && !"/".equals(uri.getRawPath()))) {
            throw new IllegalArgumentException("请输入完整的服务器地址，且地址不能包含路径或账号");
        }
        host = host.toLowerCase(Locale.ROOT);
        boolean loopback = "localhost".equals(host) || "127.0.0.1".equals(host) || "[::1]".equals(host);
        if (!https && !(debug && loopback && "http".equalsIgnoreCase(scheme))) {
            throw new IllegalArgumentException("服务器需要使用 HTTPS");
        }
        int port = uri.getPort();
        return (https ? "https://" : "http://") + host +
            (port == -1 || port == (https ? 443 : 80) ? "" : ":" + port);
    }

    static Response request(String origin, String route, JSObject body, String cookie)
        throws IOException, JSONException {
        final URI relative;
        try {
            relative = URI.create(route == null ? "" : route);
        } catch (IllegalArgumentException invalid) {
            throw new IllegalArgumentException("接口地址无效");
        }
        String path = relative.getRawPath();
        if (relative.isAbsolute() || relative.getRawAuthority() != null ||
            relative.getRawFragment() != null || !allowedPath(path, body != null) ||
            (relative.getRawQuery() != null && !"/api/sync/changes".equals(path) &&
                !"/api/ai/weights".equals(path))) {
            throw new IllegalArgumentException("接口地址无效");
        }

        HttpURLConnection connection = (HttpURLConnection) new URL(origin + route).openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(path.startsWith("/api/ai/") ? 90_000 : 12_000);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            if (!cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
            if (body != null) {
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("X-Calendar-Request", "1");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(payload.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(payload);
                }
            }

            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) throw new HttpError(status, "服务器返回了重定向，请填写最终 HTTPS 地址");
            boolean ok = status >= 200 && status < 300;
            JSObject data;
            try (InputStream input = ok ? connection.getInputStream() : connection.getErrorStream()) {
                String text = input == null ? "" : readText(input, MAX_RESPONSE_BYTES);
                try {
                    data = new JSObject(text);
                } catch (JSONException invalid) {
                    if (ok) throw new HttpError(status, "服务器返回了无法识别的数据");
                    data = new JSObject();
                }
            }
            if (!ok) throw new HttpError(status, data.getString("error", "服务器请求失败（" + status + "）"));
            return new Response(data, issuedCookie(connection));
        } finally {
            connection.disconnect();
        }
    }

    private static boolean allowedPath(String path, boolean write) {
        if (path == null) return false;
        switch (path) {
            case "/api/auth/options":
            case "/api/auth/me":
            case "/api/sync/snapshot":
            case "/api/sync/changes":
            case "/api/sync/conflicts":
            case "/api/ai/status":
            case "/api/ai/weights":
                return !write;
            case "/api/auth/login":
            case "/api/auth/register":
            case "/api/auth/logout":
            case "/api/sync/push":
            case "/api/sync/resolve":
            case "/api/ai/quick-capture":
            case "/api/ai/cognitive-weight":
                return write;
            case "/api/ai/config":
                return true;
            default:
                return false;
        }
    }

    private static String issuedCookie(HttpURLConnection connection) {
        for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet()) {
            if (!"Set-Cookie".equalsIgnoreCase(header.getKey())) continue;
            for (String value : header.getValue()) {
                Matcher match = SESSION_COOKIE.matcher(value);
                if (match.find()) return "calendar_session=" + match.group(1);
            }
        }
        return "";
    }

    static String readText(InputStream input, int maxBytes) throws IOException {
        try (ByteArrayOutputStream result = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            for (int count; (count = input.read(buffer)) != -1; ) {
                if (result.size() + count > maxBytes) throw new IOException("文件或响应过大");
                result.write(buffer, 0, count);
            }
            return new String(result.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
