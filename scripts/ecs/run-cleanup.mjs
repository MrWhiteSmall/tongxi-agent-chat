const token = process.env.CHAT_CLEANUP_TOKEN;
if (!token) throw new Error('CHAT_CLEANUP_TOKEN missing');
const response = await fetch('http://127.0.0.1:4317/internal/daily-cleanup', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + token },
  signal: AbortSignal.timeout(900_000)
});
if (!response.ok) throw new Error('Daily cleanup HTTP ' + response.status);
console.log(await response.text());
