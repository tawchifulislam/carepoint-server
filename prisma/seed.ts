import 'dotenv/config';
import cuid from 'cuid';
import { faker } from '@faker-js/faker';
import { prisma } from '../src/lib/prisma.js';

const SPECIALTIES = [
  'Cardiology',
  'Dermatology',
  'Pediatrics',
  'Orthopedics',
  'Neurology',
  'Psychiatry',
  'General Medicine',
  'Gynecology',
  'ENT',
  'Dentistry',
  'Ophthalmology',
  'Urology',
];

const CLINIC_COUNT = 15;
const DOCTORS_PER_CLINIC = 8;
const PATIENT_COUNT = 300;
const APPOINTMENTS_PER_DOCTOR = 20;

type AppointmentStatus =
  | 'PENDING_PAYMENT'
  | 'BOOKED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW';

function randomDhakaTime(
  hourStart: number,
  hourEnd: number,
): { hour: number; minute: number } {
  const hour = faker.number.int({ min: hourStart, max: hourEnd - 1 });
  const minute = faker.helpers.arrayElement([0, 30]);
  return { hour, minute };
}

function seedEmail(): string {
  return faker.internet
    .email({ provider: 'seed.carepoint.test' })
    .toLowerCase();
}

async function main() {
  const existingClinics = await prisma.clinic.count({
    where: { approvalStatus: 'APPROVED' },
  });

  if (existingClinics >= CLINIC_COUNT) {
    console.log(
      `Already have ${existingClinics} approved clinics, skipping seed.`,
    );
    return;
  }

  console.log('Seeding clinics and doctors...');

  const doctors: { id: string; consultationFee: number }[] = [];

  for (let c = 0; c < CLINIC_COUNT; c++) {
    const adminUser = await prisma.user.create({
      data: {
        name: faker.person.fullName(),
        email: seedEmail(),
        role: 'CLINIC_ADMIN',
        emailVerified: true,
      },
    });

    const clinic = await prisma.clinic.create({
      data: {
        name: `${faker.company.name()} Clinic`,
        address: faker.location.streetAddress({ useFullAddress: true }),
        adminUserId: adminUser.id,
        approvalStatus: 'APPROVED',
      },
    });

    for (let d = 0; d < DOCTORS_PER_CLINIC; d++) {
      const doctorUser = await prisma.user.create({
        data: {
          name: `Dr. ${faker.person.fullName()}`,
          email: seedEmail(),
          role: 'DOCTOR',
          emailVerified: true,
        },
      });

      const consultationFee = faker.number.int({ min: 20, max: 80 });

      const doctor = await prisma.doctor.create({
        data: {
          userId: doctorUser.id,
          clinicId: clinic.id,
          specialty: faker.helpers.arrayElement(SPECIALTIES),
          consultationFee,
          bio: faker.lorem.sentence(),
          approvalStatus: 'APPROVED',
        },
      });

      await prisma.availability.createMany({
        data: [
          {
            doctorId: doctor.id,
            weekday: 1,
            startTime: '09:00',
            endTime: '17:00',
            slotDurationMin: 30,
            bufferMin: 5,
          },
          {
            doctorId: doctor.id,
            weekday: 3,
            startTime: '09:00',
            endTime: '17:00',
            slotDurationMin: 30,
            bufferMin: 5,
          },
        ],
      });

      doctors.push({ id: doctor.id, consultationFee });
    }
  }

  console.log(`Created ${doctors.length} doctors. Seeding patients...`);

  const patientIds: string[] = [];

  for (let p = 0; p < PATIENT_COUNT; p++) {
    const patient = await prisma.user.create({
      data: {
        name: faker.person.fullName(),
        email: seedEmail(),
        role: 'PATIENT',
        emailVerified: true,
      },
    });
    patientIds.push(patient.id);
  }

  console.log('Seeding appointments and payments...');

  const appointmentRows: {
    id: string;
    doctorId: string;
    patientId: string;
    slotStart: Date;
    slotEnd: Date;
    status: AppointmentStatus;
  }[] = [];

  const paymentRows: {
    id: string;
    appointmentId: string;
    stripePaymentIntentId: string;
    amount: number;
    status: 'SUCCEEDED';
  }[] = [];

  const now = Date.now();

  for (const doctor of doctors) {
    const usedStarts = new Set<number>();

    for (let i = 0; i < APPOINTMENTS_PER_DOCTOR; i++) {
      const dayOffset = faker.number.int({ min: -45, max: 45 });
      const { hour, minute } = randomDhakaTime(9, 17);

      const slotStart = new Date(now + dayOffset * 24 * 60 * 60 * 1000);
      slotStart.setUTCHours(hour - 6, minute, 0, 0);

      if (usedStarts.has(slotStart.getTime())) {
        continue;
      }
      usedStarts.add(slotStart.getTime());

      const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000);
      const isPast = slotStart.getTime() < now;

      const status: AppointmentStatus = isPast
        ? faker.helpers.weightedArrayElement([
            { value: 'COMPLETED', weight: 6 },
            { value: 'CANCELLED', weight: 2 },
            { value: 'NO_SHOW', weight: 2 },
          ])
        : faker.helpers.weightedArrayElement([
            { value: 'BOOKED', weight: 7 },
            { value: 'PENDING_PAYMENT', weight: 2 },
            { value: 'CANCELLED', weight: 1 },
          ]);

      const id = cuid();
      const patientId = faker.helpers.arrayElement(patientIds);

      appointmentRows.push({
        id,
        doctorId: doctor.id,
        patientId,
        slotStart,
        slotEnd,
        status,
      });

      if (status === 'BOOKED' || status === 'COMPLETED') {
        paymentRows.push({
          id: cuid(),
          appointmentId: id,
          stripePaymentIntentId: `pi_seed_${id}`,
          amount: doctor.consultationFee,
          status: 'SUCCEEDED',
        });
      }
    }
  }

  await prisma.appointment.createMany({ data: appointmentRows });
  await prisma.payment.createMany({ data: paymentRows });

  console.log(
    `Created ${appointmentRows.length} appointments and ${paymentRows.length} payments.`,
  );
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
