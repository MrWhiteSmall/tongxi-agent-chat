package app.tongxi.chat;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;
import java.io.IOException;
import java.io.OutputStream;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.json.JSONException;

public final class ChatActivity extends Activity {
    static final Uri ORIGIN = Uri.parse("https://47.117.247.11:9443");
    private static final int PICK_FILES = 1;
    private static final int SAVE_FILE = 2;

    private WebView chat;
    private LinearLayout startup;
    private TextView startupStatus;
    private Button startupRetry;
    private boolean waitingForFrame;
    private int startupAttempt;
    private final Runnable startupDelay = () -> {
        if (startup.getVisibility() == View.VISIBLE) showStartupRetry("仍在连接同席…");
    };
    private ValueCallback<Uri[]> fileChoice;
    private byte[] download;
    private boolean saving;

    private static final int NOTIFICATION_PERMISSION = 3;
    private String notificationSession;
    private String persistedSession;
    private boolean checkingSession;

    private final Runnable checkSession = new Runnable() {
        @Override
        public void run() {
            if (!checkingSession) return;
            String page = chat.getUrl();
            if (page != null && sameOrigin(Uri.parse(page))) {
                int attempt = startupAttempt;
                chat.evaluateJavascript("JSON.stringify({token: sessionStorage.getItem('token')," +
                        "ready: ['workspace', 'login'].some(id => document.getElementById(id)?.hidden === false)})", result -> {
                    if (!checkingSession || result == null) return;
                    try {
                        Object value = new JSONTokener(result).nextValue();
                        if (!(value instanceof String) || attempt != startupAttempt) return;
                        JSONObject pageState = new JSONObject((String) value);
                        if (pageState.optBoolean("ready")) {
                            revealChat(attempt);
                            updateNotifications(pageState.isNull("token") ? null : pageState.optString("token"));
                        }
                    } catch (JSONException ignored) {}
                });
            }
            chat.postDelayed(this, startup.getVisibility() == View.VISIBLE ? 150 : 1000);
        }
    };

    private void updateNotifications(String token) {
        if (!java.util.Objects.equals(token, persistedSession)) {
            persistedSession = token;
            CookieManager.getInstance().flush();
        }
        if (token == null || !token.matches("[0-9a-f-]{72}")) {
            notificationSession = null;
            stopService(new Intent(this, MessageNotifications.class));
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            String key = "notificationsAsked";
            if (!getPreferences(MODE_PRIVATE).getBoolean(key, false)) {
                getPreferences(MODE_PRIVATE).edit().putBoolean(key, true).apply();
                requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATION_PERMISSION);
            }
            return;
        }
        if (!getSystemService(NotificationManager.class).areNotificationsEnabled()) return;
        if (token.equals(notificationSession) && MessageNotifications.hasSession(token)) return;
        notificationSession = token;
        Intent service = new Intent(this, MessageNotifications.class).putExtra("session", token);
        startForegroundService(service);
    }

    @Override
    protected void onResume() {
        super.onResume();
        MessageNotifications.chatVisible = true;
        getSystemService(NotificationManager.class).cancel(MessageNotifications.MESSAGE_ID);
        checkingSession = true;
        chat.post(checkSession);
    }

    @Override
    protected void onPause() {
        checkingSession = false;
        chat.removeCallbacks(checkSession);
        CookieManager.getInstance().flush();
        MessageNotifications.chatVisible = false;
        super.onPause();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void installStartup() {
        FrameLayout root = new FrameLayout(this);
        root.addView(chat, new FrameLayout.LayoutParams(-1, -1));
        startup = new LinearLayout(this);
        startup.setOrientation(LinearLayout.VERTICAL);
        startup.setGravity(Gravity.CENTER);
        startup.setBackgroundColor(getColor(R.color.startup_background));
        startup.setClickable(true);
        ImageView mark = new ImageView(this);
        mark.setImageResource(R.drawable.startup_logo);
        mark.setContentDescription("同席 Logo");
        startup.addView(mark, new LinearLayout.LayoutParams(dp(192), dp(192)));
        startupStatus = new TextView(this);
        startupStatus.setTextColor(0xFFE8F1FF);
        startupStatus.setTextSize(16);
        startupStatus.setGravity(Gravity.CENTER);
        startupStatus.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        startup.addView(startupStatus, new LinearLayout.LayoutParams(-1, -2));
        startupRetry = new Button(this);
        startupRetry.setText("重试");
        startupRetry.setOnClickListener(view -> {
            resetStartup();
            chat.loadUrl(ORIGIN + "/");
        });
        LinearLayout.LayoutParams retryLayout = new LinearLayout.LayoutParams(-2, -2);
        retryLayout.topMargin = dp(12);
        startup.addView(startupRetry, retryLayout);
        root.addView(startup, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        resetStartup();
    }

    private void resetStartup() {
        startupAttempt++;
        waitingForFrame = false;
        startupStatus.setText("正在打开同席…");
        startupRetry.setVisibility(View.INVISIBLE);
        chat.removeCallbacks(startupDelay);
        chat.postDelayed(startupDelay, 12_000);
    }

    private void showStartupRetry(String message) {
        if (startup == null || startup.getVisibility() != View.VISIBLE) return;
        startupStatus.setText(message);
        startupRetry.setVisibility(View.VISIBLE);
        chat.removeCallbacks(startupDelay);
    }

    private void revealChat(int attempt) {
        if (startup.getVisibility() != View.VISIBLE || waitingForFrame) return;
        waitingForFrame = true;
        chat.postVisualStateCallback(attempt, new WebView.VisualStateCallback() {
            @Override
            public void onComplete(long requestId) {
                if (requestId != startupAttempt) return;
                startup.setVisibility(View.GONE);
                chat.removeCallbacks(startupDelay);
            }
        });
    }

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        chat = new WebView(this);
        chat.getSettings().setJavaScriptEnabled(true);
        chat.getSettings().setDomStorageEnabled(true);
        chat.getSettings().setAllowFileAccess(false);
        chat.getSettings().setAllowContentAccess(false);
        chat.getSettings().setMediaPlaybackRequiresUserGesture(true);
        chat.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showStartupRetry("暂时无法连接同席");
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
                if (request.isForMainFrame()) showStartupRetry("暂时无法连接同席");
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!request.isForMainFrame() || sameOrigin(uri)) return false;
                if (request.hasGesture() && "https".equals(uri.getScheme())) openExternal(uri);
                return true;
            }
        });
        chat.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (fileChoice != null) fileChoice.onReceiveValue(null);
                fileChoice = callback;
                try {
                    startActivityForResult(params.createIntent(), PICK_FILES);
                } catch (ActivityNotFoundException error) {
                    fileChoice = null;
                    callback.onReceiveValue(null);
                    notice("找不到文件选择器");
                }
                return true;
            }
        });
        chat.setDownloadListener((url, agent, disposition, mime, size) -> {
            if (!url.startsWith("blob:" + ORIGIN + "/")) {
                Uri uri = Uri.parse(url);
                if ("https".equals(uri.getScheme())) openExternal(uri);
                return;
            }
            String page = chat.getUrl();
            if (saving || page == null || !sameOrigin(Uri.parse(page))) return;
            saveBlob(url, URLUtil.guessFileName(url, disposition, mime), mime);
        });
        installStartup();
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::navigateBack);
        }
        if (state == null || chat.restoreState(state) == null) chat.loadUrl(ORIGIN + "/");
    }

    private static boolean sameOrigin(Uri uri) {
        return "https".equals(uri.getScheme()) && ORIGIN.getHost().equals(uri.getHost())
                && ORIGIN.getPort() == uri.getPort();
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException error) {
            notice("找不到可打开链接的应用");
        }
    }

    private void saveBlob(String url, String filename, String mime) {
        saving = true;
        WebMessagePort[] ports = chat.createWebMessageChannel();
        Runnable timeout = () -> {
            ports[0].close();
            saving = false;
            notice("下载超时，请重试");
        };
        ports[0].setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override
            public void onMessage(WebMessagePort port, WebMessage message) {
                chat.removeCallbacks(timeout);
                port.close();
                try {
                    String encoded = message.getData();
                    if (encoded == null || !encoded.startsWith("ok:") || encoded.length() > 24 * 1024 * 1024 + 3) {
                        throw new IllegalArgumentException();
                    }
                    download = Base64.decode(encoded.substring(3), Base64.DEFAULT);
                    Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                            .addCategory(Intent.CATEGORY_OPENABLE)
                            .setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime)
                            .putExtra(Intent.EXTRA_TITLE, filename);
                    startActivityForResult(create, SAVE_FILE);
                } catch (IllegalArgumentException | ActivityNotFoundException error) {
                    saving = false;
                    download = null;
                    notice("无法保存此文件");
                }
            }
        });
        String token = java.util.UUID.randomUUID().toString();
        String script = "(() => { const receive = async e => {"
                + "if (e.data !== " + JSONObject.quote(token) + " || !e.ports.length) return;"
                + "removeEventListener('message', receive); const port = e.ports[0];"
                + "try { const b = await (await fetch(" + JSONObject.quote(url) + ")).blob();"
                + "if (b.size > 18 * 1024 * 1024) throw Error();"
                + "const r = new FileReader(); r.onload = () => port.postMessage('ok:' + r.result.split(',')[1]);"
                + "r.onerror = () => port.postMessage(''); r.readAsDataURL(b);"
                + "} catch (_) { port.postMessage(''); } };"
                + "addEventListener('message', receive);"
                + "setTimeout(() => removeEventListener('message', receive), 8000); })()";
        chat.postDelayed(timeout, 8000);
        chat.evaluateJavascript(script, ignored ->
                chat.postWebMessage(new WebMessage(token, new WebMessagePort[] { ports[1] }), ORIGIN));
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_FILES && fileChoice != null) {
            ValueCallback<Uri[]> callback = fileChoice;
            fileChoice = null;
            callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        } else if (request == SAVE_FILE) {
            byte[] bytes = download;
            download = null;
            saving = false;
            if (result != RESULT_OK || data == null || data.getData() == null || bytes == null) return;
            try (OutputStream out = getContentResolver().openOutputStream(data.getData())) {
                if (out == null) throw new IOException();
                out.write(bytes);
                notice("文件已保存");
            } catch (IOException error) {
                notice("文件保存失败");
            }
        }
    }

    private void notice(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        chat.saveState(state);
        super.onSaveInstanceState(state);
    }

    private void navigateBack() {
        String page = chat.getUrl();
        if (page == null || !sameOrigin(Uri.parse(page))) {
            if (chat.canGoBack()) chat.goBack();
            else moveTaskToBack(true);
            return;
        }
        chat.evaluateJavascript("typeof window.tongxiBack === 'function' && window.tongxiBack()", handled -> {
            if (!"true".equals(handled)) moveTaskToBack(true);
        });
    }

    @Override
    public void onBackPressed() {
        navigateBack();
    }
}
