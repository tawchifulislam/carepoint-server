import 'dotenv/config';
import { app } from './app.js';
import { prisma } from './lib/prisma.js';
import { startPaymentSweepScheduler } from './services/payment-sweep.service.js';
import { startReminderScheduler } from './services/reminder.service.js';

const PORT = Number(process.env.PORT ?? 4000);

const server = app.listen(PORT, () => {
  console.log(`CarePoint server running on port ${PORT}`);
  startReminderScheduler();
  startPaymentSweepScheduler();
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);

  setTimeout(() => process.exit(1), 10_000).unref();

  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
