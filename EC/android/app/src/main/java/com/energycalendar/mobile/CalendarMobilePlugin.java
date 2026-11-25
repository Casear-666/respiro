package com.energycalendar.mobile;

import android.app.Activity;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(name = "CalendarMobile")
public class CalendarMobilePlugin extends Plugin {
    private static final int MAX_BACKUP_BYTES = 20 * 1024 * 1024;
    private static final String LOGIN = "/api/auth/login";
    private static final String REGISTER = "/api/auth/register";
    private static final String LOGOUT = "/api/auth/logout";
    private static final String OPTIONS = "/api/auth/options";

    private final ExecutorService background = Executors.newFixedThreadPool(3);
    private final Object sessionLock = new Object();
    private CalendarSessionStore sessions;
    private CalendarSessionStore.Session candidate;

    @Override
    public void load() {
        sessions = new CalendarSessionStore(getContext().getApplicationContext());
    }

    @Override
    protected void handleOnDestroy() {
        background.shutdown();
    }

    @PluginMethod
    public void request(PluginCall call) {
        background.execute(() -> {
            try {
                String origin = CalendarTransport.origin(call.getString("origin"), isDebuggable());
                String route = call.getString("route", "");
                String session = call.getString("session", "none");
                JSObject body = call.getObject("body");
                if (call.getData().has("body") && body == null) {
                    throw new IllegalArgumentException("请求内容需要 JSON 对象");
                }

                boolean signingIn = LOGIN.equals(route) || REGISTER.equals(route);
                String cookie = "";
                if (!signingIn && !OPTIONS.equals(route)) {
                    if (LOGOUT.equals(route)) throw new IllegalArgumentException("请使用账号退出操作");
                    synchronized (sessionLock) {
                        CalendarSessionStore.Session record = "candidate".equals(session) ? candidate :
                            "active".equals(session) ? sessions.read() : null;
                        if (record == null || record.cookie.isEmpty() || !record.origin.equals(origin)) {
                            throw new CalendarTransport.HttpError(401, "请重新登录；离线日程仍保存在本机");
                        }
                        cookie = record.cookie;
                    }
                }

                CalendarTransport.Response response = CalendarTransport.request(origin, route, body, cookie);
                if (signingIn) rememberCandidate(origin, response);
                call.resolve(response.data);
            } catch (CalendarTransport.HttpError error) {
                call.reject(error.getMessage(), Integer.toString(error.status));
            } catch (IllegalArgumentException error) {
                call.reject(error.getMessage());
            } catch (SocketTimeoutException error) {
                call.reject("连接服务器超时，请稍后重试");
            } catch (IOException | JSONException error) {
                call.reject("暂时无法连接服务器，请检查地址、网络和证书");
            }
        });
    }

    @PluginMethod
    public void getSession(PluginCall call) {
        CalendarSessionStore.Session session = sessions.read();
        call.resolve(new JSObject().put("session", session == null ? JSONObject.NULL : session.metadata()));
    }

    @PluginMethod
    public void commitSession(PluginCall call) {
        JSObject data = call.getObject("session");
        JSObject user = data == null ? null : data.getJSObject("user");
        CalendarSessionStore.Session previous;
        synchronized (sessionLock) {
            if (candidate == null || user == null || !candidate.origin.equals(data.getString("origin")) ||
                !candidate.user.getString("id").equals(user.getString("id"))) {
                call.reject("本次登录会话已失效");
                return;
            }
            try {
                previous = sessions.replace(candidate);
                candidate = null;
            } catch (GeneralSecurityException | IOException error) {
                call.reject("无法安全保存账号会话，请重试");
                return;
            }
        }
        call.resolve();
        revoke(previous);
    }

    @PluginMethod
    public void clearCandidate(PluginCall call) {
        CalendarSessionStore.Session discarded;
        synchronized (sessionLock) {
            discarded = candidate;
            candidate = null;
        }
        call.resolve();
        revoke(discarded);
    }

    @PluginMethod
    public void setSession(PluginCall call) {
        if (!call.getData().has("session") || !call.getData().isNull("session")) {
            call.reject("保存会话需要已验证的登录");
            return;
        }
        CalendarSessionStore.Session previous;
        synchronized (sessionLock) {
            try {
                previous = sessions.replace(null);
            } catch (GeneralSecurityException | IOException error) {
                call.reject("无法清除本机会话，请重试");
                return;
            }
        }
        call.resolve();
        revoke(previous);
    }

    private void rememberCandidate(String origin, CalendarTransport.Response response) throws CalendarTransport.HttpError {
        JSObject user = response.data.getJSObject("user");
        if (user == null || user.getString("id") == null || user.getString("username") == null || response.cookie.isEmpty()) {
            throw new CalendarTransport.HttpError(502, "服务器未返回有效的账号会话");
        }
        CalendarSessionStore.Session previous;
        synchronized (sessionLock) {
            previous = candidate;
            candidate = new CalendarSessionStore.Session(origin, user, response.cookie);
        }
        revoke(previous);
    }

    private void revoke(CalendarSessionStore.Session session) {
        if (session == null || session.cookie.isEmpty() || background.isShutdown()) return;
        background.execute(() -> {
            try {
                CalendarTransport.request(session.origin, LOGOUT, new JSObject(), session.cookie);
            } catch (IOException | JSONException ignored) {
                // Local sign-out is already durable. A disconnected session expires on the server.
            }
        });
    }

    private boolean isDebuggable() {
        return (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    @PluginMethod
    public void pickBackup(PluginCall call) {
        Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        picker.addCategory(Intent.CATEGORY_OPENABLE);
        picker.setType("*/*");
        startActivityForResult(call, picker, "backupSelected");
    }

    @ActivityCallback
    private void backupSelected(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        Uri uri = data == null ? null : data.getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            call.resolve(new JSObject().put("canceled", true));
            return;
        }
        background.execute(() -> {
            try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
                if (input == null) throw new IOException("文件不可读");
                String text = CalendarTransport.readText(input, MAX_BACKUP_BYTES);
                call.resolve(new JSObject().put("text", text.startsWith("\uFEFF") ? text.substring(1) : text));
            } catch (IOException | SecurityException error) {
                call.reject("无法读取备份，或文件超过 20 MB");
            }
        });
    }

    @PluginMethod
    public void shareBackup(PluginCall call) {
        String name = call.getString("name", "");
        String text = call.getString("text");
        if (name.length() > 120 || !name.endsWith(".json") || name.contains("/") ||
            name.contains("\\") || name.indexOf('\0') >= 0 || text == null) {
            call.reject("备份文件名无效");
            return;
        }
        background.execute(() -> {
            try {
                byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
                if (bytes.length > MAX_BACKUP_BYTES) throw new IOException("备份文件超过 20 MB");
                Context context = getContext();
                File directory = new File(context.getCacheDir(), "calendar-backups/" + UUID.randomUUID());
                if (!directory.mkdirs()) throw new IOException("无法创建备份文件");
                File file = new File(directory, name);
                try (FileOutputStream output = new FileOutputStream(file)) {
                    output.write(bytes);
                }
                Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
                Intent share = new Intent(Intent.ACTION_SEND);
                share.setType("application/json");
                share.putExtra(Intent.EXTRA_STREAM, uri);
                share.setClipData(ClipData.newRawUri(name, uri));
                share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().runOnUiThread(() -> {
                    getActivity().startActivity(Intent.createChooser(share, "分享精力日历备份"));
                    call.resolve(new JSObject().put("ok", true));
                });
            } catch (IOException | IllegalArgumentException error) {
                call.reject(error.getMessage());
            }
        });
    }
}
