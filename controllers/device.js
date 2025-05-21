import { db } from "../config/config.js";
import { collection, query, where, getDocs, addDoc, updateDoc, orderBy, limit } from "firebase/firestore";

// Store connected clients for SSE
const clients = new Set();

let lastUID = null;
let lastTimestamp = null;
let lastStudentData = null;

// Helper function to check if time is within curfew hours (10:30 PM to 6:00 AM)
const isDuringCurfew = (date) => {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  // Curfew is from 22:30 (10:30 PM) to 06:00 (6:00 AM)
  return (hours > 22 || (hours === 22 && minutes >= 30)) || 
         (hours < 6 || (hours === 6 && minutes === 0));
};

// Check if student has valid permit for current time
const hasValidPermit = async (studentNumber, currentTime) => {
  try {
    const permitsRef = collection(db, "permits");
    const q = query(
      permitsRef,
      where("student_no", "==", studentNumber),
      where("status", "==", "approved")
    );
    
    const querySnapshot = await getDocs(q);
    
    for (const doc of querySnapshot.docs) {
      const permit = doc.data();
      
      // Convert expected dates/times to Date objects for comparison
      const expectedDeparture = new Date(`${permit.expected_date}T${permit.expected_time}:00`);
      const expectedArrival = new Date(`${permit.expected_arrival_date}T${permit.expected_arrival_time}:00`);
      
      // Check if current time is within permit window
      if (currentTime >= expectedDeparture && currentTime <= expectedArrival) {
        return true; // Valid permit found
      }
    }
    
    return false; // No valid permit found
  } catch (error) {
    console.error("Error checking permits:", error);
    return false; // Assume no permit if error occurs
  }
};

// Record a violation
const recordViolation = async (studentNumber, fullName, violationType, description) => {
  try {
    const violationsRef = collection(db, "violations");
    await addDoc(violationsRef, {
      student_no: studentNumber,
      student_name: fullName,
      violation: violationType,
      description: description,
      datetime_reported: new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' }),
      timestamp: new Date(),
      status: "pending" // Can be 'pending', 'reviewed', 'resolved'
    });
    console.log(`Violation recorded for ${studentNumber}: ${violationType}`);
  } catch (error) {
    console.error("Error recording violation:", error);
  }
};

// Broadcast updates to all connected clients
const broadcastUpdate = (data) => {
  const eventData = JSON.stringify(data);
  clients.forEach(client => {
    client.res.write(`data: ${eventData}\n\n`);
  });
};

export const insertEntry = async (req, res) => {
  try {
    const { uid } = req.body;

    if (!uid) {
      return res.status(400).json({ 
        success: false, 
        error: "UID parameter is required" 
      });
    }

    const usersRef = collection(db, "users");
    const q = query(usersRef, where("uid", "==", uid));
    const querySnapshot = await getDocs(q);

    if (querySnapshot.empty) {
      const registrationLink = `https://dormwatch.netlify.app/auth/register?uid=${uid}`;
      const responseData = {
        success: false, 
        message: "User not registered",
        registrationLink,
        uid
      };
      
      broadcastUpdate(responseData);
      return res.status(404).json(responseData);
    }

    // User exists - get student data
    const userDoc = querySnapshot.docs[0];
    const userData = userDoc.data();
    
    // Construct full name and get student number
    const firstName = userData.first_name || '';
    const middleName = userData.middle_name ? `${userData.middle_name.charAt(0)}.` : '';
    const lastName = userData.last_name || '';
    const fullName = `${firstName} ${middleName} ${lastName}`.replace(/\s+/g, ' ').trim();
    const studentNumber = userData.student_number || '';
    const dormResidence = userData.dorm_residence || 'Unknown';

    const timestamp = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
    const now = new Date();

    // Check for curfew violation
    let hasViolation = false;
    let hasPermit = false;
    
    if (isDuringCurfew(now)) {
      hasPermit = await hasValidPermit(studentNumber, now);
      
      if (!hasPermit) {
        // Record curfew violation
        await recordViolation(
          studentNumber,
          fullName,
          "Curfew Violation",
          `Student entered/left dorm during curfew hours (10:30 PM - 6:00 AM) without valid permit`
        );
        hasViolation = true;
      }
    }

    // Check for the latest entry of this student
    const entriesRef = collection(db, "entries");
    const studentEntriesQuery = query(
      entriesRef,
      where("student_no", "==", studentNumber),
      orderBy("time_in", "desc"),
      limit(1)
    );

    const latestEntrySnapshot = await getDocs(studentEntriesQuery);
    let responseData;

    if (!latestEntrySnapshot.empty) {
      const latestEntry = latestEntrySnapshot.docs[0];
      const latestEntryData = latestEntry.data();
      
      // If latest entry doesn't have time_out, update it
      if (!latestEntryData.time_out) {
        await updateDoc(latestEntry.ref, {
          time_out: timestamp,
          time_out_timestamp: now
        });

        responseData = {
          success: true,
          uid,
          name: fullName,
          studentNumber,
          timestamp,
          message: "Time out recorded",
          entryType: "time_out",
          isDuringCurfew: isDuringCurfew(now),
          hasPermit,
          hasViolation
        };
      } else {
        // Create new time_in entry
        await addDoc(entriesRef, {
          student_no: studentNumber,
          student_name: fullName,
          dorm_residence: dormResidence,
          time_in: timestamp,
          time_in_timestamp: now,
          time_out: "",
          time_out_timestamp: null
        });

        responseData = {
          success: true,
          uid,
          name: fullName,
          studentNumber,
          timestamp,
          message: "Time in recorded",
          entryType: "time_in",
          isDuringCurfew: isDuringCurfew(now),
          hasPermit,
          hasViolation
        };
      }
    } else {
      // First entry for this student - time in
      await addDoc(entriesRef, {
        student_no: studentNumber,
        student_name: fullName,
        dorm_residence: dormResidence,
        time_in: timestamp,
        time_in_timestamp: now,
        time_out: "",
        time_out_timestamp: null
      });

      responseData = {
        success: true,
        uid,
        name: fullName,
        studentNumber,
        timestamp,
        message: "Time in recorded",
        entryType: "time_in",
        isDuringCurfew: isDuringCurfew(now),
        hasPermit,
        hasViolation
      };
    }

    // Update last entry data
    lastUID = uid;
    lastTimestamp = timestamp;
    lastStudentData = {
      fullName,
      studentNumber,
      isDuringCurfew: isDuringCurfew(now),
      hasPermit,
      hasViolation
    };
    
    broadcastUpdate(responseData);
    res.status(200).json(responseData);

  } catch (error) {
    console.error("Error in insertEntry:", error);
    res.status(500).json({ 
      success: false, 
      error: "Internal server error" 
    });
  }
};

export const getLatestEntry = async (req, res) => {
  res.status(200).json({ 
    success: true, 
    uid: lastUID, 
    name: lastStudentData?.fullName || '',
    studentNumber: lastStudentData?.studentNumber || '',
    timestamp: lastTimestamp  
  });
};

export const sseUpdates = (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Send initial data with all relevant information
  res.write(`data: ${JSON.stringify({
    uid: lastUID,
    name: lastStudentData?.fullName || '',
    studentNumber: lastStudentData?.studentNumber || '',
    timestamp: lastTimestamp,
    isDuringCurfew: lastStudentData?.isDuringCurfew || false,
    hasPermit: lastStudentData?.hasPermit || false,
    hasViolation: lastStudentData?.hasViolation || false
  })}\n\n`);

  const clientId = Date.now();
  const newClient = {
    id: clientId,
    res
  };
  clients.add(newClient);

  req.on('close', () => {
    clients.delete(newClient);
  });
};