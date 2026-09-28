import { formatInTimeZone } from 'date-fns-tz';
import { prisma } from '../lib/prisma.js';
import { resend } from '../lib/resend.js';

const CLINIC_TIMEZONE = 'Asia/Dhaka';
const EMAIL_FROM =
  process.env.EMAIL_FROM ?? 'CarePoint <onboarding@resend.dev>';

interface BookingConfirmation {
  appointmentId: string;
  patientName: string;
  patientEmail: string;
  doctorName: string;
  specialty: string;
  clinicName: string;
  clinicAddress: string;
  slotStart: Date;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSlot(date: Date): string {
  return formatInTimeZone(
    date,
    CLINIC_TIMEZONE,
    "EEEE, d MMMM yyyy 'at' h:mm a",
  );
}

function row(label: string, value: string): string {
  return `
    <tr>
      <td style="padding: 6px 12px 6px 0; color: #5b6b79;">${label}</td>
      <td style="padding: 6px 0;">${escapeHtml(value)}</td>
    </tr>`;
}

async function sendBookingConfirmation(
  details: BookingConfirmation,
): Promise<void> {
  const when = formatSlot(details.slotStart);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #12181f;">
      <h2 style="color: #0e6e55;">Your appointment is confirmed</h2>
      <p>Hi ${escapeHtml(details.patientName)},</p>
      <p>Your consultation has been booked and paid.</p>
      <table style="border-collapse: collapse; margin: 16px 0;">
        ${row('Doctor', details.doctorName)}
        ${row('Specialty', details.specialty)}
        ${row('Clinic', details.clinicName)}
        ${row('Address', details.clinicAddress)}
        ${row('When', when)}
        ${row('Reference', details.appointmentId)}
      </table>
      <p style="color: #5b6b79; font-size: 13px;">Time shown in Bangladesh time (Asia/Dhaka).</p>
    </div>`;

  const { error } = await resend.emails.send({
    from: EMAIL_FROM,
    to: details.patientEmail,
    subject: `Appointment confirmed: ${when}`,
    html,
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function notifyBookingConfirmed(
  appointmentId: string,
): Promise<void> {
  try {
    const appointment = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
      include: {
        patient: true,
        doctor: { include: { user: true, clinic: true } },
      },
    });

    await sendBookingConfirmation({
      appointmentId: appointment.id,
      patientName: appointment.patient.name,
      patientEmail: appointment.patient.email,
      doctorName: appointment.doctor.user.name,
      specialty: appointment.doctor.specialty,
      clinicName: appointment.doctor.clinic.name,
      clinicAddress: appointment.doctor.clinic.address,
      slotStart: appointment.slotStart,
    });
  } catch (error) {
    console.error('Booking confirmation email failed', error);
  }
}
