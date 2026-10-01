import 'dotenv/config';
import { app } from './app.js';
import { startReminderScheduler } from './services/reminder.service.js';

const PORT = process.env.PORT ?? 4000;

app.listen(PORT, () => {
  console.log(`CarePoint server running on port ${PORT}`);
  startReminderScheduler();
});
