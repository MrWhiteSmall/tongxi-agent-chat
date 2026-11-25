package app.tongxi.chat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class MessageNotifications extends Service {
    static final int MESSAGE_ID = 2;
    static volatile boolean chatVisible;
    private static final int SERVICE_ID = 1;
    private static final String SERVICE_CHANNEL = "message_monitor";
    private static final String MESSAGE_CHANNEL = "chat_messages";
    private static volatile String session;
    private volatile boolean destroyed;
    private ScheduledExecutorService executor;
    private NotificationManager manager;
    private PendingIntent openChat;
    private String cursorSession;
    private Map<String, JSONObject> seen;

    static boolean hasSession(String candidate) {
        return candidate.equals(session);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(
                SERVICE_CHANNEL, "后台消息连接", NotificationManager.IMPORTANCE_LOW));
        NotificationChannel messages = new NotificationChannel(
                MESSAGE_CHANNEL, "新聊天消息", NotificationManager.IMPORTANCE_HIGH);
        messages.enableVibration(true);
        messages.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(messages);
        Intent open = new Intent(this, ChatActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        openChat = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        session = intent == null ? null : intent.getStringExtra("session");
        if (session == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(SERVICE_ID, new Notification.Builder(this, SERVICE_CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle("同席正在接收消息")
                .setContentIntent(openChat)
                .setOngoing(true)
                .build());
        if (executor == null) {
            executor = Executors.newSingleThreadScheduledExecutor();
            executor.scheduleWithFixedDelay(this::poll, 0, 5, TimeUnit.SECONDS);
        }
        return START_NOT_STICKY;
    }

    private void poll() {
        String token = session;
        if (destroyed || token == null) return;
        try {
            JSONArray rooms = fetchRooms(token);
            if (destroyed || !token.equals(session) || rooms == null) return;
            int changed = 0;
            boolean initialized = seen != null && token.equals(cursorSession);
            if (!initialized) seen = new HashMap<>();
            for (int i = 0; i < rooms.length(); i++) {
                JSONObject item = rooms.getJSONObject(i);
                String room = item.getString("room");
                String id = item.getString("id");
                JSONObject previous = initialized ? seen.get(room) : null;
                if (previous == null || (item.getLong("at") >= previous.getLong("at")
                        && !id.equals(previous.getString("id")))) {
                    seen.put(room, item);
                    if (initialized) changed++;
                }
            }
            cursorSession = token;
            if (changed > 0 && !chatVisible && manager.areNotificationsEnabled()) {
                manager.notify(MESSAGE_ID, new Notification.Builder(this, MESSAGE_CHANNEL)
                        .setSmallIcon(android.R.drawable.stat_notify_chat)
                        .setContentTitle("同席")
                        .setContentText(changed == 1 ? "你有一条新聊天消息" : changed + " 个会话有新消息")
                        .setCategory(Notification.CATEGORY_MESSAGE)
                        .setVisibility(Notification.VISIBILITY_PRIVATE)
                        .setContentIntent(openChat)
                        .setAutoCancel(true)
                        .build());
            }
        } catch (IOException | JSONException ignored) {
            // The next poll retries after a temporary network or server failure.
        }
    }

    private JSONArray fetchRooms(String token) throws IOException, JSONException {
        URL url = new URL(ChatActivity.ORIGIN + "/api/notifications");
        HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        connection.setRequestProperty("Authorization", "Bearer " + token);
        try {
            int status = connection.getResponseCode();
            if (status == 401 && token.equals(session)) {
                stopSelf();
                return null;
            }
            if (status != 200) return null;
            try (InputStream in = connection.getInputStream();
                    ByteArrayOutputStream body = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096];
                int count;
                while ((count = in.read(buffer)) != -1) body.write(buffer, 0, count);
                return new JSONObject(new String(body.toByteArray(), StandardCharsets.UTF_8)).getJSONArray("rooms");
            }
        } finally {
            connection.disconnect();
        }
    }

    @Override
    public void onDestroy() {
        destroyed = true;
        session = null;
        if (executor != null) executor.shutdownNow();
        manager.cancel(MESSAGE_ID);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
