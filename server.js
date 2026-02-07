require('dotenv').config(); 
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const e = require('express');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = path.join(__dirname, 'data');

// Configuration email
const EMAIL_CONFIG = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || 'votre-email@gmail.com',
    pass: process.env.SMTP_PASS || 'votre-mot-de-passe'
  }
};

// Configuration SMS Twilio (à remplacer par vos vraies credentials)
const TWILIO_CONFIG = {
  accountSid: process.env.TWILIO_SID || '',
  authToken: process.env.TWILIO_TOKEN || '',
  fromNumber: process.env.TWILIO_PHONE || ''
};


// Middleware
app.use(cors());
app.use(express.json());

// Fichiers de données
const FILES = {
  availabilities: path.join(DATA_DIR, 'availabilities.json'),
  appointments: path.join(DATA_DIR, 'appointments.json'),
  adminToken: path.join(DATA_DIR, 'admin-token.json'),
  settings: path.join(DATA_DIR, 'settings.json')
};

// ============================================
// FONCTIONS UTILITAIRES POUR NETTOYAGE
// ============================================

// Convertir "HH:MM" en minutes depuis minuit
function timeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

// Vérifier si un créneau doit être supprimé
function shouldDeleteSlot(slot, dateStr) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  
  const slotMinutes = timeToMinutes(slot.time);
  const slotDate = dateStr;
  
  // Si le créneau est réservé, ne pas le supprimer
  if (slot.isBooked) {
    return false;
  }
  
  // Si la date est passée → supprimer
  if (slotDate < today) {
    return true;
  }
  
  // Si c'est aujourd'hui et qu'il reste moins de 5h avant le créneau → supprimer
  if (slotDate === today) {
    const minutesUntilSlot = slotMinutes - currentMinutes;
    if (minutesUntilSlot <= 300) {
      return true;
    }
  }
  
  return false;
}

// Fonction de nettoyage des créneaux expirés
async function cleanupExpiredSlots() {
  try {
    console.log('🧹 Début du nettoyage des créneaux expirés...');
    
    const availabilities = await readJson(FILES.availabilities);
    let totalDeleted = 0;
    let daysModified = 0;
    
    const updatedAvailabilities = availabilities.map(day => {
      const originalSlotsCount = day.slots.length;
      
      // Filtrer les créneaux à conserver
      const remainingSlots = day.slots.filter(slot => {
        const shouldDelete = shouldDeleteSlot(slot, day.date);
        if (shouldDelete) {
          console.log(`  🗑️  Supprimé: ${day.date} à ${slot.time} (non réservé)`);
          totalDeleted++;
        }
        return !shouldDelete;
      });
      
      if (remainingSlots.length !== originalSlotsCount) {
        daysModified++;
      }
      
      return {
        ...day,
        slots: remainingSlots
      };
    }).filter(day => day.slots.length > 0); // Supprimer les jours sans créneaux
    
    const daysDeleted = availabilities.length - updatedAvailabilities.length;
    
    await writeJson(FILES.availabilities, updatedAvailabilities);
    
    console.log(`✅ Nettoyage terminé:`);
    console.log(`   - ${totalDeleted} créneaux supprimés`);
    console.log(`   - ${daysModified} jours modifiés`);
    console.log(`   - ${daysDeleted} jours vides supprimés`);
    
  } catch (error) {
    console.error('❌ Erreur lors du nettoyage:', error);
  }
}

// ============================================
// TÂCHES PLANIFIÉES
// ============================================

// Nettoyer toutes les 60 minutes
cron.schedule('*/60 * * * *', async () => {
  console.log('⏰ Tâche planifiée: vérification des créneaux expirés');
  await cleanupExpiredSlots();
});

// Nettoyage au démarrage (après 5 secondes)
setTimeout(async () => {
  await cleanupExpiredSlots();
}, 5000);

// Initialisation
async function initFiles() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    
    for (const [key, filePath] of Object.entries(FILES)) {
      let needsInit = false;
      
      try {
        await fs.access(filePath);
        const content = await fs.readFile(filePath, 'utf8');
        if (!content || content.trim() === '') {
          needsInit = true;
        } else {
          try {
            JSON.parse(content);
          } catch (e) {
            needsInit = true;
          }
        }
      } catch {
        needsInit = true;
      }
      
      if (needsInit) {
        let defaultData;
        if (key === 'adminToken') {
          defaultData = { token: uuidv4(), createdAt: new Date().toISOString() };
        } else if (key === 'settings') {
          defaultData = {
            businessName: 'Massonjo Chauffage Sanitaire',
            businessPhone: '07 50 97 26 01',
            businessEmail: 'massonjoetfils@gmail.com',
            businessAddress: '189 Rue des Moineaux, 74930 Reignier-Ésery',
            emailNotifications: true,
            smsNotifications: true
          };
        } else {
          defaultData = [];
        }
        await fs.writeFile(filePath, JSON.stringify(defaultData, null, 2));
        console.log(`✓ Initialisé: ${path.basename(filePath)}`);
      }
    }
    
    const adminData = await readJson(FILES.adminToken);
    console.log('\n🔑 Token Admin:', adminData.token);
    console.log('🔗 URL Admin: http://localhost:' + PORT + '/admin/' + adminData.token);
    console.log('\n');
  } catch (error) {
    console.error('Erreur initialisation:', error);
  }
}

// Lecture JSON sécurisée
async function readJson(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    if (!data || data.trim() === '') {
      return filePath.includes('adminToken') ? { token: uuidv4() } : 
             filePath.includes('settings') ? {} : [];
    }
    return JSON.parse(data);
  } catch (error) {
    console.error(`Erreur lecture ${path.basename(filePath)}:`, error.message);
    if (filePath.includes('adminToken')) return { token: uuidv4() };
    if (filePath.includes('settings')) return {};
    return [];
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

// Envoyer email de confirmation
async function sendConfirmationEmail(appointment, settings) {
  try {
    const transporter = nodemailer.createTransport(EMAIL_CONFIG);
    
    const dateFormatee = new Date(appointment.date).toLocaleDateString('fr-FR', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    
    const mailOptions = {
      from: `"${settings.businessName}" <${settings.businessEmail}>`,
      to: appointment.email,
      subject: '✅ Confirmation de votre rendez-vous',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #F26440; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">${settings.businessName}</h1>
          </div>
          <div style="padding: 20px; background: #f9f9f9;">
            <h2 style="color: #333;">Bonjour ${appointment.firstName},</h2>
            <p>Votre rendez-vous est confirmé !</p>
            
            <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="color: #F26440; margin-top: 0;">📅 Détails du rendez-vous</h3>
              <p><strong>Date :</strong> ${dateFormatee}</p>
              <p><strong>Heure :</strong> ${appointment.time}</p>
              <p><strong>Service :</strong> ${appointment.service}</p>
              <p><strong>Durée estimée :</strong> ${appointment.duration} minutes</p>
            </div>
            
            <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="color: #F26440; margin-top: 0;">📍 Notre adresse</h3>
              <p>${settings.businessAddress}</p>
              <p><strong>Tél :</strong> ${settings.businessPhone}</p>
            </div>
            
            <p style="color: #666; font-size: 14px;">
              Pour modifier ou annuler votre rendez-vous, contactez-nous au ${settings.businessPhone}.
            </p>
          </div>
          <div style="background: #333; color: white; padding: 20px; text-align: center; font-size: 12px;">
            <p>${settings.businessName} - Plombier Chauffagiste en Haute-Savoie</p>
          </div>
        </div>
      `
    };
    
    await transporter.sendMail(mailOptions);
    console.log(`📧 Email envoyé à ${appointment.email}`);
    return true;
  } catch (error) {
    console.error('Erreur envoi email:', error);
    return false;
  }
}

// Envoyer SMS de confirmation (simulation si Twilio non configuré)
async function sendConfirmationSMS(appointment, settings) {
  if (!TWILIO_CONFIG.accountSid) {
    console.log(`📱 SMS simulé à ${appointment.phone}: RDV confirmé le ${appointment.date} à ${appointment.time}`);
    return true;
  }
  
  try {
    // const twilio = require("twilio"); // Or, for ESM: import twilio from "twilio";


    const twilio = require('twilio')(TWILIO_CONFIG.accountSid, TWILIO_CONFIG.authToken);
    console.log(`📱 SMS envoyé à ${appointment.phone}`);
    

    if (appointment.service === "Visite") {
        // SMS client 
        await twilio.messages.create({
            body: `\n
            ${settings.businessName}: Votre RDV est confirmé le ${appointment.date} à ${appointment.time}.\n\nMotif: ${appointment.service} facturé 50€(règlement Espèce) \n\nAu plaisir de vous voir ! \n\nPour toute modification, contactez-nous au ${settings.businessPhone}.`,
            from: TWILIO_CONFIG.fromNumber,
            //   to: `+33${appointment.phone}`,
            to: `+33${appointment.phone}`,
        });
    } else {
        // SMS client
        await twilio.messages.create({
            body: `\n
            ${settings.businessName}: Votre RDV est confirmé le ${appointment.date} à ${appointment.time}\nMotif: ${appointment.service}.\nAu plaisir de vous voir ! \n\nPour toute modification, contactez-nous au ${settings.businessPhone}.`,
            from: TWILIO_CONFIG.fromNumber,
            //   to: `+33${appointment.phone}`,
            to: `+33${appointment.phone}`,
        });
    }


            // SMS admin/Plombier
        await twilio.messages.create({
            body: `\n
            ${settings.businessName}: Vous avez un RDV le ${appointment.date} à ${appointment.time}. 
            - Par: ${appointment.firstName} ${appointment.lastName}\n- Motif: ${appointment.service}\n- tel: ${appointment.phone}\n- adresse: ${appointment.address} \n\nGerez vos RDV sur votre espace admin: https://www.massonjo-chauffage-sanitaire.fr/admin/${(await readJson(FILES.adminToken)).token}
            `,
            from: TWILIO_CONFIG.fromNumber,
            // to: `+330695190411`, // Numéro de test pour éviter d'envoyer des SMS réels pendant le développement
              to: `+330750972601`,
        });



    //       firstName,
    //   lastName,
    //   email,
    //   phone,
    
    // console.log(`📱 SMS envoyé à ${appointment.phone}`);
    // // return true;
    // const client = twilio(TWILIO_CONFIG.accountSid, TWILIO_CONFIG.authToken);
    // const message = await client.messages.create({
    //     body: `${settings.businessName}: Votre RDV est confirmé le ${appointment.date} à ${appointment.time}. Au plaisir de vous voir !`,
    //     from: "",
    //     to: `+33${appointment.phone}`,
    // });
    console.log("sms sent");
  } catch (error) {
    console.error('Erreur envoi SMS:', error);
    return false;
  }
}

// Middleware de vérification token admin
function verifyAdminToken(req, res, next) {
  const token = req.headers['x-admin-token'] || req.params.token;
  
  readJson(FILES.adminToken)
    .then(adminData => {
      if (adminData.token === token) {
        next();
      } else {
        res.status(401).json({ error: 'Token invalide' });
      }
    })
    .catch(err => res.status(500).json({ error: 'Erreur serveur' }));
}

// ============ ROUTES API ============

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ============ DISPONIBILITÉS ============

// Mettre à jour les créneaux d'une date (sans perdre les réservations)
app.put('/api/availabilities/:id/slots', verifyAdminToken, async (req, res) => {
  try {
    const { slots } = req.body;
    const availabilities = await readJson(FILES.availabilities);
    const dayIndex = availabilities.findIndex(a => a.id === req.params.id);
    
    if (dayIndex === -1) {
      return res.status(404).json({ error: 'Date non trouvée' });
    }
    
    // Conserver les créneaux existants avec leur état isBooked
    const existingDay = availabilities[dayIndex];
    const existingSlotsMap = new Map(existingDay.slots.map(s => [s.time, s]));
    
    // Fusionner: nouveaux créneaux + conservation de isBooked si existant
    const mergedSlots = slots.map(newSlot => {
      const existing = existingSlotsMap.get(newSlot.time);
      return {
        id: existing ? existing.id : uuidv4(),
        time: newSlot.time,
        duration: newSlot.duration || 60,
        isBooked: existing ? existing.isBooked : false
      };
    });
    
    existingDay.slots = mergedSlots;
    existingDay.updatedAt = new Date().toISOString();
    
    await writeJson(FILES.availabilities, availabilities);
    res.json({ success: true, data: existingDay });
  } catch (error) {
    res.status(500).json({ error: 'Erreur mise à jour créneaux' });
  }
});

app.get('/api/availabilities', async (req, res) => {
  try {
    const { start, end } = req.query;
    let availabilities = await readJson(FILES.availabilities);
    
    if (start && end) {
      availabilities = availabilities.filter(a => {
        const date = new Date(a.date);
        return date >= new Date(start) && date <= new Date(end);
      });
    }
    
    res.json(availabilities);
  } catch (error) {
    res.status(500).json({ error: 'Erreur lecture disponibilités' });
  }
});

app.post('/api/availabilities', verifyAdminToken, async (req, res) => {
  try {
    const { date, slots } = req.body;
    
    if (!date || !slots || !Array.isArray(slots)) {
      return res.status(400).json({ error: 'Données invalides' });
    }
    
    const availabilities = await readJson(FILES.availabilities);
    const existingIndex = availabilities.findIndex(a => a.date === date);
    
    const newEntry = {
      id: uuidv4(),
      date,
      slots: slots.map(slot => ({
        id: uuidv4(),
        time: slot.time,
        duration: slot.duration || 60,
        isBooked: false
      })),
      createdAt: new Date().toISOString()
    };
    
    if (existingIndex >= 0) {
      const existing = availabilities[existingIndex];
      existing.slots = [...existing.slots, ...newEntry.slots];
      existing.updatedAt = new Date().toISOString();
    } else {
      availabilities.push(newEntry);
    }
    
    await writeJson(FILES.availabilities, availabilities);
    res.json({ success: true, data: newEntry });
  } catch (error) {
    res.status(500).json({ error: 'Erreur création disponibilité' });
  }
});

app.delete('/api/availabilities/:id', verifyAdminToken, async (req, res) => {
  try {
    const availabilities = await readJson(FILES.availabilities);
    const filtered = availabilities.filter(a => a.id !== req.params.id);
    await writeJson(FILES.availabilities, filtered);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erreur suppression' });
  }
});

// ============ RENDEZ-VOUS ============

app.get('/api/appointments', verifyAdminToken, async (req, res) => {
  try {
    const appointments = await readJson(FILES.appointments);
    res.json(appointments);
  } catch (error) {
    res.status(500).json({ error: 'Erreur lecture rendez-vous' });
  }
});

app.post('/api/appointments', async (req, res) => {
  try {
    const { firstName, lastName, email, phone, address, service, date, slotId, notes } = req.body;
    
    if (!firstName || !lastName || !email || !phone || !date || !slotId) {
      return res.status(400).json({ error: 'Champs obligatoires manquants' });
    }
    
    const availabilities = await readJson(FILES.availabilities);
    const daySlots = availabilities.find(a => a.date === date);

    // console.log('====================================');
    // console.log("req.body :", req.body);
    // console.log("availabilities :", availabilities);
    // console.log("daySlots :", daySlots);
    // console.log('====================================');
    
    if (!daySlots) {
        console.log(`Date ${date} non trouvée dans les disponibilités`);
      return res.status(400).json({ error: 'Date non disponible' });
    }
    
    const slot = daySlots.slots.find(s => s.id === slotId);
    if (!slot || slot.isBooked) {
      return res.status(400).json({ error: 'Créneau non disponible' });
    }
    
    const appointment = {
      id: uuidv4(),
      firstName,
      lastName,
      email,
      phone,
      address: address || '',
      service: service || 'Non spécifié',
      date,
      slotId,
      time: slot.time,
      duration: slot.duration,
      notes: notes || '',
      status: 'confirmed',
      createdAt: new Date().toISOString()
    };
    
    slot.isBooked = true;
    await writeJson(FILES.availabilities, availabilities);
    
    const appointments = await readJson(FILES.appointments);
    appointments.push(appointment);
    await writeJson(FILES.appointments, appointments);
    
    // Envoyer les notifications
    const settings = await readJson(FILES.settings);
    
    // if (settings.emailNotifications) {
    //   await sendConfirmationEmail(appointment, settings);
    // }
    // console.log('====================================');
    // console.log("googing to send email/SMS...");
    // console.log('====================================');
    if (settings.smsNotifications) {
      await sendConfirmationSMS(appointment, settings);
    }
    
    res.json({ 
      success: true, 
      data: appointment,
      message: 'Rendez-vous confirmé. Vous recevrez une confirmation par email' + 
               (settings.smsNotifications ? ' et SMS.' : '.')
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur création rendez-vous' });
  }
});

app.delete('/api/appointments/:id', async (req, res) => {
  try {
    const appointments = await readJson(FILES.appointments);
    const appointment = appointments.find(a => a.id === req.params.id);
    
    if (!appointment) {
      return res.status(404).json({ error: 'Rendez-vous non trouvé' });
    }
    
    const availabilities = await readJson(FILES.availabilities);
    const daySlots = availabilities.find(a => a.date === appointment.date);
    if (daySlots) {
      const slot = daySlots.slots.find(s => s.id === appointment.slotId);
      if (slot) slot.isBooked = false;
      await writeJson(FILES.availabilities, availabilities);
    }
    
    const filtered = appointments.filter(a => a.id !== req.params.id);

    const settings = await readJson(FILES.settings);
    const twilio = require('twilio')(TWILIO_CONFIG.accountSid, TWILIO_CONFIG.authToken);
    console.log(`📱 SMS envoyé à ${appointment.phone}`);
    
    await twilio.messages.create({
      body: `
      ${settings.businessName}: Votre RDV du ${appointment.date} -- ${appointment.time}  à été annulé.\nAu plaisir de vous voir ! \n\nPour toute informations, contactez-nous au ${settings.businessPhone}.`,
      from: TWILIO_CONFIG.fromNumber,
    //   to: `+33${appointment.phone}`,
      to: `+33${appointment.phone}`,
    });


    await writeJson(FILES.appointments, filtered);
    
    res.json({ success: true, message: 'Rendez-vous annulé' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur annulation' });
  }
});

// ============ ADMIN ============

app.get('/api/admin/token', async (req, res) => {
  try {
    const adminData = await readJson(FILES.adminToken);
    res.json({ token: adminData.token });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lecture token' });
  }
});

app.post('/api/admin/refresh-token', verifyAdminToken, async (req, res) => {
  try {
    const newToken = uuidv4();
    await writeJson(FILES.adminToken, { 
      token: newToken, 
      createdAt: new Date().toISOString() 
    });
    res.json({ token: newToken });
  } catch (error) {
    res.status(500).json({ error: 'Erreur rafraîchissement token' });
  }
});

app.get('/api/admin/stats', verifyAdminToken, async (req, res) => {
  try {
    const appointments = await readJson(FILES.appointments);
    const availabilities = await readJson(FILES.availabilities);
    
    const today = new Date().toISOString().split('T')[0];
    const todayAppointments = appointments.filter(a => a.date === today);
    
    const totalSlots = availabilities.reduce((acc, day) => acc + day.slots.length, 0);
    const bookedSlots = availabilities.reduce((acc, day) => 
      acc + day.slots.filter(s => s.isBooked).length, 0);
    
    res.json({
      totalAppointments: appointments.length,
      todayAppointments: todayAppointments.length,
      upcomingAppointments: appointments.filter(a => a.date >= today).length,
      totalSlots,
      bookedSlots,
      availableSlots: totalSlots - bookedSlots
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur statistiques' });
  }
});

// Paramètres
app.get('/api/admin/settings', verifyAdminToken, async (req, res) => {
  try {
    const settings = await readJson(FILES.settings);
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: 'Erreur lecture settings' });
  }
});

app.put('/api/admin/settings', verifyAdminToken, async (req, res) => {
  try {
    await writeJson(FILES.settings, req.body);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erreur sauvegarde settings' });
  }
});

// ============ TÂCHES PLANIFIÉES ============

cron.schedule('0 0 * * *', async () => {
  try {
    const availabilities = await readJson(FILES.availabilities);
    const today = new Date().toISOString().split('T')[0];
    
    const filtered = availabilities.filter(a => a.date >= today);
    await writeJson(FILES.availabilities, filtered);
    
    console.log(`🧹 Nettoyage effectué: ${availabilities.length - filtered.length} anciennes dates supprimées`);
  } catch (error) {
    console.error('Erreur nettoyage:', error);
  }
});

// Démarrage
app.listen(PORT, async () => {
  console.log(`\\n🚀 Serveur démarré sur http://localhost:${PORT}`);
  await initFiles();
});

module.exports = app;
