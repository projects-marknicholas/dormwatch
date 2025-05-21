import { db } from "../config/config.js";
import { collection, query, where, getDocs, addDoc, updateDoc, doc, orderBy, limit } from "firebase/firestore";

// Store connected clients for SSE
const clients = new Set();

let lastUID = null;
let lastTimestamp = null;
let lastStudentData = null;

// Helper function to check if time is within curfew hours (10:30 PM to 6:00 AM)
const isDuringCurfew = (date) => {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  
  return (hours > 22 || (hours === 22 && minutes >= 30)) || 
         (hours < 6);
};

// Improved permit checking with better error handling
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
      
      try {
        // Parse dates with proper timezone handling
        const departureDateStr = `${permit.expected_date}T${permit.expected_time}`;
        const arrivalDateStr = `${permit.expected_arrival_date}T${permit.expected_arrival_time}`;
        
        // Create dates in local timezone (assuming dates are stored in PH time)
        const departureDate = new Date(departureDateStr);
        const arrivalDate = new Date(arrivalDateStr);

        // Add debug logging
        console.log('Checking permit window:');
        console.log('Current time:', currentTime);
        console.log('Departure time:', departureDate);
        console.log('Arrival time:', arrivalDate);

        if (currentTime >= departureDate && currentTime <= arrivalDate) {
          return {
            hasPermit: true,
            permitData: {
              ...permit,
              id: doc.id
            }
          };
        }
      } catch (dateError) {
        console.error('Error parsing permit dates:', dateError);
        continue; // Skip this permit if date parsing fails
      }
    }
    
    return {
      hasPermit: false,
      permitData: null
    };
  } catch (error) {
    console.error("Error checking permits:", error);
    return {
      hasPermit: false,
      permitData: null
    };
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
      status: "pending"
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
    
    const permitCheck = await hasValidPermit(studentNumber, now);
    const hasPermit = permitCheck.hasPermit;
    const permitData = permitCheck.permitData;
    let hasViolation = false;
    
    if (isDuringCurfew(now) && !hasPermit) {
      console.log(`Recording violation for ${studentNumber} at ${now.toLocaleString()}`);
      await recordViolation(
        studentNumber,
        fullName,
        "Curfew Violation",
        `Student entered/left dorm during curfew hours (10:30 PM - 6:00 AM) without valid permit`
      );
      hasViolation = true;
    }

    // Check for the latest entry of this student
    const entriesRef = collection(db, "entries");
    const studentEntriesQuery = query(
      entriesRef,
      where("student_no", "==", studentNumber),
      orderBy("time_in_timestamp", "desc"),
      limit(1)
    );

    const latestEntrySnapshot = await getDocs(studentEntriesQuery);
    let responseData;

    if (!latestEntrySnapshot.empty) {
      const latestEntry = latestEntrySnapshot.docs[0];
      const latestEntryData = latestEntry.data();
      
      // If latest entry doesn't have time_out, update it
      if (!latestEntryData.time_out) {
        const updateData = {
          time_out: timestamp,
          time_out_timestamp: now,
          has_violation: hasViolation
        };
        
        if (hasPermit) {
          updateData.permit_id = permitData.id;
          updateData.permit_type = permitData.type_of_permit;
        }

        await updateDoc(latestEntry.ref, updateData);

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
          hasViolation,
          permit: hasPermit ? {
            type: permitData.type_of_permit,
            expectedReturn: `${permitData.expected_arrival_date} ${permitData.expected_arrival_time}`
          } : null
        };
      } else {
        // Create new time_in entry
        const entryData = {
          student_no: studentNumber,
          student_name: fullName,
          dorm_residence: dormResidence,
          time_in: timestamp,
          time_in_timestamp: now,
          time_out: "",
          time_out_timestamp: null,
          has_violation: hasViolation
        };
        
        if (hasPermit) {
          entryData.permit_id = permitData.id;
          entryData.permit_type = permitData.type_of_permit;
        }

        await addDoc(entriesRef, entryData);

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
          hasViolation,
          permit: hasPermit ? {
            type: permitData.type_of_permit,
            expectedReturn: `${permitData.expected_arrival_date} ${permitData.expected_arrival_time}`
          } : null
        };
      }
    } else {
      // First entry for this student - time in
      const entryData = {
        student_no: studentNumber,
        student_name: fullName,
        dorm_residence: dormResidence,
        time_in: timestamp,
        time_in_timestamp: now,
        time_out: "",
        time_out_timestamp: null,
        has_violation: hasViolation
      };
      
      if (hasPermit) {
        entryData.permit_id = permitData.id;
        entryData.permit_type = permitData.type_of_permit;
      }

      await addDoc(entriesRef, entryData);

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
        hasViolation,
        permit: hasPermit ? {
          type: permitData.type_of_permit,
          expectedReturn: `${permitData.expected_arrival_date} ${permitData.expected_arrival_time}`
        } : null
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
      hasViolation,
      permit: hasPermit ? {
        type: permitData.type_of_permit,
        expectedReturn: `${permitData.expected_arrival_date} ${permitData.expected_arrival_time}`
      } : null
    };
    
    broadcastUpdate(responseData);
    res.status(200).json(responseData);

  } catch (error) {
    console.error("Error in insertEntry:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message || "Internal server error" 
    });
  }
};

export const getLatestEntry = async (req, res) => {
  res.status(200).json({ 
    success: true, 
    uid: lastUID, 
    name: lastStudentData?.fullName || '',
    studentNumber: lastStudentData?.studentNumber || '',
    timestamp: lastTimestamp,
    isDuringCurfew: lastStudentData?.isDuringCurfew || false,
    hasPermit: lastStudentData?.hasPermit || false,
    permit: lastStudentData?.permit || null,
    hasViolation: lastStudentData?.hasViolation || false
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
    permit: lastStudentData?.permit || null,
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
