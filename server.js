require('dotenv').config();
const express=require('express'),mysql=require('mysql2/promise'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),path=require('path'),fs=require('fs');
const app=express();app.use(express.json());app.use(express.static(path.join(__dirname,'public')));
const SECRET=process.env.JWT_SECRET||'dev-secret-change-me',CAP=50;
const db=mysql.createPool({host:process.env.DB_HOST||'127.0.0.1',port:process.env.DB_PORT||3306,user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'',database:process.env.DB_NAME||'fudma_health_center',dateStrings:true,multipleStatements:true,connectionLimit:10,ssl:process.env.DB_SSL?{rejectUnauthorized:false}:undefined});
const Q=async(s,p)=>(await db.query(s,p))[0];
const bad=(m,s=400)=>{const e=new Error(m);e.status=s;return e};
const wrap=f=>(a,b)=>f(a,b).catch(e=>{console.error(e);b.status(e.status||500).json({error:e.status?e.message:'Server error'})});
const auth=(...roles)=>(a,b,n)=>{try{a.user=jwt.verify((a.headers.authorization||'').slice(7),SECRET)}catch{return b.status(401).json({error:'Please log in'})}if(roles.length&&!roles.includes(a.user.role))return b.status(403).json({error:'Not allowed'});n()};
const today=()=>new Date().toISOString().slice(0,10);
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
const isDate=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'');
const checkDate=d=>{if(!isDate(d))throw bad('Invalid date');if(d<today()||d>addDays(today(),30))throw bad('Pick a date within the next 30 days')};
const p2=n=>String(n).padStart(2,'0');
function slots(s,e){const o=[];let [h,m]=s.split(':').map(Number);const [eh,em]=e.split(':').map(Number);while(h*60+m+30<=eh*60+em){o.push(p2(h)+':'+p2(m));m+=30;if(m>=60){h++;m-=60}}return o}
async function tx(fn){const c=await db.getConnection();try{await c.beginTransaction();const r=await fn(c);await c.commit();return r}catch(e){await c.rollback();throw e}finally{c.release()}}

// ---- auth ----
app.post('/api/register',wrap(async(req,res)=>{
  const b=req.body,em=(b.email||'').toLowerCase().trim();
  if(!b.first_name||!b.last_name||!['Male','Female'].includes(b.gender)||!/^\S+@\S+\.\S+$/.test(em)||(b.password||'').length<8)throw bad('Fill all required fields. Password needs 8+ characters.');
  if((await Q('SELECT 1 FROM users WHERE username=?',[em])).length)throw bad('This email is already registered',409);
  const hash=await bcrypt.hash(b.password,10);
  const card=await tx(async c=>{
    const [r]=await c.query('INSERT INTO patients(card_number,first_name,last_name,gender,date_of_birth,phone_number,email,address,blood_group) VALUES(?,?,?,?,?,?,?,?,?)',['TMP'+Date.now()+Math.random(),b.first_name,b.last_name,b.gender,b.date_of_birth||null,b.phone_number||null,em,b.address||null,b.blood_group||null]);
    const id=`HMS-${new Date().getFullYear()}-${String(r.insertId).padStart(3,'0')}`;
    await c.query('UPDATE patients SET card_number=? WHERE patient_id=?',[id,r.insertId]);
    await c.query('INSERT INTO users(username,password_hash,role,ref_id) VALUES(?,?,?,?)',[em,hash,'patient',r.insertId]);
    return id});
  res.json({card_number:card});
}));
app.post('/api/login',wrap(async(req,res)=>{
  const [u]=await Q('SELECT * FROM users WHERE username=?',[(req.body.username||'').toLowerCase().trim()]);
  if(!u||!(await bcrypt.compare(req.body.password||'',u.password_hash)))throw bad('Wrong username or password',401);
  let name=u.username,card=null;
  if(u.role==='patient'){const [p]=await Q('SELECT first_name,card_number FROM patients WHERE patient_id=?',[u.ref_id]);name=p.first_name;card=p.card_number}
  if(u.role==='doctor'){const [d]=await Q('SELECT last_name FROM doctors WHERE doctor_id=?',[u.ref_id]);name='Dr. '+d.last_name}
  if(u.role==='lab'&&u.full_name)name=u.full_name;
  res.json({token:jwt.sign({id:u.user_id,role:u.role,ref:u.ref_id},SECRET,{expiresIn:'8h'}),role:u.role,name,card_number:card});
}));

// ---- patient ----
app.get('/api/doctors/available',auth('patient'),wrap(async(req,res)=>{
  checkDate(req.query.date);
  const docs=await Q(`SELECT d.doctor_id,d.first_name,d.last_name,d.specialization,r.start_time,r.end_time FROM duty_roster r JOIN doctors d USING(doctor_id) WHERE r.duty_date=? AND d.availability_status='Available'`,[req.query.date]);
  const taken=await Q(`SELECT doctor_id,appointment_time t FROM appointments WHERE appointment_date=? AND appointment_status<>'Cancelled'`,[req.query.date]);
  res.json(docs.map(d=>({...d,slots:slots(d.start_time,d.end_time).filter(s=>!taken.some(t=>t.doctor_id===d.doctor_id&&t.t.slice(0,5)===s))})));
}));
app.post('/api/appointments',auth('patient'),wrap(async(req,res)=>{
  const {doctor_id,date,time,reason}=req.body;checkDate(date);
  await tx(async c=>{
    const [[r]]=await c.query('SELECT d.department_id,r.start_time,r.end_time FROM duty_roster r JOIN doctors d USING(doctor_id) WHERE r.doctor_id=? AND r.duty_date=? FOR UPDATE',[doctor_id,date]);
    if(!r||!slots(r.start_time,r.end_time).includes(time))throw bad('That doctor is not on duty at that time');
    const [x]=await c.query(`SELECT 1 FROM appointments WHERE doctor_id=? AND appointment_date=? AND appointment_time=? AND appointment_status<>'Cancelled'`,[doctor_id,date,time]);
    if(x.length)throw bad('That slot was just taken. Pick another.',409);
    await c.query(`INSERT INTO appointments(patient_id,doctor_id,department_id,appointment_date,appointment_time,reason_for_visit,appointment_status) VALUES(?,?,?,?,?,?,'Approved')`,[req.user.ref,doctor_id,r.department_id,date,time,(reason||'').slice(0,500)||null]);
  });
  res.json({ok:true});
}));
app.get('/api/my/appointments',auth('patient'),wrap(async(req,res)=>res.json(await Q(`SELECT a.appointment_id,a.appointment_date,a.appointment_time,a.appointment_status,CONCAT('Dr. ',d.first_name,' ',d.last_name) doctor,a.reason_for_visit FROM appointments a JOIN doctors d USING(doctor_id) WHERE a.patient_id=? ORDER BY a.appointment_date DESC,a.appointment_time`,[req.user.ref]))));
app.patch('/api/appointments/:id/cancel',auth('patient'),wrap(async(req,res)=>{await Q(`UPDATE appointments SET appointment_status='Cancelled' WHERE appointment_id=? AND patient_id=? AND appointment_status IN('Pending','Approved')`,[req.params.id,req.user.ref]);res.json({ok:true})}));
app.post('/api/lab-bookings',auth('patient'),wrap(async(req,res)=>{
  const {test_name,date,time}=req.body;checkDate(date);
  if(!test_name||!/^\d\d:\d\d$/.test(time||''))throw bad('Test name and time are required');
  const [lab]=await Q('SELECT opening_time,closing_time,laboratory_status FROM laboratories WHERE laboratory_id=1');
  if(!lab||lab.laboratory_status!=='Open'||time<lab.opening_time.slice(0,5)||time>=lab.closing_time.slice(0,5))throw bad('The lab is closed at that time');
  await tx(async c=>{
    await c.query('SELECT laboratory_id FROM laboratories WHERE laboratory_id=1 FOR UPDATE');
    const [[{n}]]=await c.query(`SELECT COUNT(*) n FROM lab_results WHERE test_date=? AND test_status<>'Cancelled'`,[date]);
    if(n>=CAP)throw bad('The lab is fully booked that day. Pick another date.',409);
    await c.query('INSERT INTO lab_results(patient_id,laboratory_id,test_name,test_date,test_time) VALUES(?,1,?,?,?)',[req.user.ref,test_name.slice(0,100),date,time]);
  });
  res.json({ok:true});
}));
app.get('/api/my/labs',auth('patient'),wrap(async(req,res)=>res.json(await Q('SELECT lab_result_id,test_name,test_date,test_time,test_status,test_result FROM lab_results WHERE patient_id=? ORDER BY test_date DESC,test_time',[req.user.ref]))));
app.patch('/api/labs/:id/cancel',auth('patient'),wrap(async(req,res)=>{await Q(`UPDATE lab_results SET test_status='Cancelled' WHERE lab_result_id=? AND patient_id=? AND test_status='Pending'`,[req.params.id,req.user.ref]);res.json({ok:true})}));

// ---- doctor ----
app.get('/api/doctor/schedule',auth('doctor'),wrap(async(req,res)=>{
  const d=isDate(req.query.date)?req.query.date:today();
  const rows=await Q(`SELECT a.appointment_id,a.appointment_time,a.appointment_status,a.reason_for_visit,p.patient_id,p.card_number,p.gender,p.date_of_birth,p.blood_group,p.phone_number,CONCAT(p.first_name,' ',p.last_name) patient FROM appointments a JOIN patients p USING(patient_id) WHERE a.doctor_id=? AND a.appointment_date=? AND a.appointment_status<>'Cancelled' ORDER BY a.appointment_time`,[req.user.ref,d]);
  const [duty]=await Q('SELECT start_time,end_time FROM duty_roster WHERE doctor_id=? AND duty_date=?',[req.user.ref,d]);
  const nurses=await Q('SELECT n.first_name,n.last_name,n.phone_number,nd.shift FROM nurse_duty nd JOIN nurses n USING(nurse_id) WHERE nd.duty_date=? ORDER BY nd.shift',[d]);
  res.json({date:d,count:rows.length,duty:duty||null,appointments:rows,nurses});
}));
app.patch('/api/doctor/appointments/:id',auth('doctor'),wrap(async(req,res)=>{await Q(`UPDATE appointments SET appointment_status='Completed' WHERE appointment_id=? AND doctor_id=?`,[req.params.id,req.user.ref]);res.json({ok:true})}));

// ---- lab staff ----
app.get('/api/lab/day',auth('lab','admin'),wrap(async(req,res)=>{
  const d=isDate(req.query.date)?req.query.date:today();
  const tests=await Q(`SELECT l.lab_result_id,l.test_name,l.test_time,l.test_status,l.test_result,p.card_number,CONCAT(p.first_name,' ',p.last_name) patient FROM lab_results l JOIN patients p USING(patient_id) WHERE l.test_date=? AND l.test_status<>'Cancelled' ORDER BY l.test_time`,[d]);
  res.json({date:d,count:tests.length,capacity:CAP,tests});
}));
app.patch('/api/lab/:id',auth('lab'),wrap(async(req,res)=>{
  const {test_status,test_result}=req.body;
  if(!['Pending','Processing','Completed'].includes(test_status))throw bad('Invalid status');
  await Q('UPDATE lab_results SET test_status=?,test_result=COALESCE(?,test_result) WHERE lab_result_id=?',[test_status,test_result||null,req.params.id]);res.json({ok:true});
}));

// ---- admin ----
const adm=auth('admin');
app.get('/api/admin/stats',adm,wrap(async(req,res)=>{const t=today();const n=async(s,p)=>(await Q(s,p))[0].n;res.json({patients:await n('SELECT COUNT(*) n FROM patients'),doctors:await n('SELECT COUNT(*) n FROM doctors'),appointments_today:await n(`SELECT COUNT(*) n FROM appointments WHERE appointment_date=? AND appointment_status<>'Cancelled'`,[t]),labs_today:await n(`SELECT COUNT(*) n FROM lab_results WHERE test_date=? AND test_status<>'Cancelled'`,[t]),doctors_on_duty_today:await n('SELECT COUNT(*) n FROM duty_roster WHERE duty_date=?',[t])})}));
app.get('/api/admin/doctors',adm,wrap(async(req,res)=>res.json(await Q('SELECT doctor_id,first_name,last_name,specialization FROM doctors ORDER BY last_name'))));
app.post('/api/admin/doctors',adm,wrap(async(req,res)=>{
  const b=req.body,em=(b.email||'').toLowerCase().trim();
  if(!b.first_name||!b.last_name||!['Male','Female'].includes(b.gender)||!b.specialization||!/^\S+@\S+\.\S+$/.test(em)||(b.password||'').length<8)throw bad('Fill all fields. Password needs 8+ characters.');
  if((await Q('SELECT 1 FROM users WHERE username=?',[em])).length)throw bad('Email already in use',409);
  const hash=await bcrypt.hash(b.password,10);
  await tx(async c=>{const [r]=await c.query('INSERT INTO doctors(first_name,last_name,gender,specialization,phone_number,email,department_id) VALUES(?,?,?,?,?,?,1)',[b.first_name,b.last_name,b.gender,b.specialization,b.phone_number||null,em]);await c.query('INSERT INTO users(username,password_hash,role,ref_id) VALUES(?,?,?,?)',[em,hash,'doctor',r.insertId])});
  res.json({ok:true});
}));
app.get('/api/admin/roster',adm,wrap(async(req,res)=>res.json(await Q(`SELECT r.roster_id,r.duty_date,r.start_time,r.end_time,CONCAT('Dr. ',d.first_name,' ',d.last_name) doctor,(SELECT COUNT(*) FROM appointments a WHERE a.doctor_id=r.doctor_id AND a.appointment_date=r.duty_date AND a.appointment_status<>'Cancelled') booked FROM duty_roster r JOIN doctors d USING(doctor_id) WHERE r.duty_date>=? ORDER BY r.duty_date,r.start_time`,[today()]))));
app.post('/api/admin/roster',adm,wrap(async(req,res)=>{
  const {doctor_id,date,start,end}=req.body;
  if(!isDate(date)||date<today()||!/^\d\d:\d\d$/.test(start||'')||!/^\d\d:\d\d$/.test(end||'')||start>=end)throw bad('Check the date and times');
  await Q('INSERT INTO duty_roster(doctor_id,duty_date,start_time,end_time) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE start_time=VALUES(start_time),end_time=VALUES(end_time)',[doctor_id,date,start,end]);res.json({ok:true});
}));
app.delete('/api/admin/roster/:id',adm,wrap(async(req,res)=>{await Q('DELETE FROM duty_roster WHERE roster_id=?',[req.params.id]);res.json({ok:true})}));

app.get('/api/doctor/duties',auth('doctor'),wrap(async(req,res)=>res.json(await Q('SELECT duty_date,start_time,end_time FROM duty_roster WHERE doctor_id=? AND duty_date>=? ORDER BY duty_date LIMIT 14',[req.user.ref,today()]))));
app.get('/api/doctor/patient/:id',auth('doctor'),wrap(async(req,res)=>{
  if(!(await Q('SELECT 1 FROM appointments WHERE patient_id=? AND doctor_id=? LIMIT 1',[req.params.id,req.user.ref])).length)throw bad('This patient has no appointment with you',403);
  const [patient]=await Q('SELECT patient_id,card_number,first_name,last_name,gender,date_of_birth,phone_number,address,blood_group FROM patients WHERE patient_id=?',[req.params.id]);
  const records=await Q(`SELECT m.record_date,CONCAT('Dr. ',d.last_name) doctor,m.symptoms,m.diagnosis,m.treatment,m.allergies,m.medical_notes FROM medical_records m JOIN doctors d USING(doctor_id) WHERE m.patient_id=? ORDER BY m.record_date DESC`,[req.params.id]);
  const labs=await Q('SELECT test_date,test_name,test_status,test_result FROM lab_results WHERE patient_id=? ORDER BY test_date DESC',[req.params.id]);
  res.json({patient,records,labs});
}));
app.post('/api/doctor/records',auth('doctor'),wrap(async(req,res)=>{
  const b=req.body;if(!b.diagnosis)throw bad('Diagnosis is required');
  const [a]=await Q('SELECT patient_id FROM appointments WHERE appointment_id=? AND doctor_id=?',[b.appointment_id,req.user.ref]);if(!a)throw bad('Appointment not found',404);
  await tx(async c=>{await c.query('INSERT INTO medical_records(patient_id,doctor_id,appointment_id,symptoms,diagnosis,treatment,allergies,medical_notes) VALUES(?,?,?,?,?,?,?,?)',[a.patient_id,req.user.ref,b.appointment_id,b.symptoms||null,b.diagnosis,b.treatment||null,b.allergies||null,b.medical_notes||null]);await c.query(`UPDATE appointments SET appointment_status='Completed' WHERE appointment_id=?`,[b.appointment_id])});
  res.json({ok:true});
}));
app.get('/api/admin/lab-staff',adm,wrap(async(req,res)=>res.json(await Q("SELECT user_id,username,full_name FROM users WHERE role='lab' ORDER BY user_id"))));
app.post('/api/admin/lab-staff',adm,wrap(async(req,res)=>{
  const b=req.body,em=(b.email||'').toLowerCase().trim();
  if(!b.full_name||!/^\S+@\S+\.\S+$/.test(em)||(b.password||'').length<8)throw bad('Fill all fields. Password needs 8+ characters.');
  if((await Q('SELECT 1 FROM users WHERE username=?',[em])).length)throw bad('Email already in use',409);
  await Q(`INSERT INTO users(username,password_hash,role,ref_id,full_name) VALUES(?,?,'lab',1,?)`,[em,await bcrypt.hash(b.password,10),b.full_name]);res.json({ok:true});
}));
app.delete('/api/admin/lab-staff/:id',adm,wrap(async(req,res)=>{await Q(`DELETE FROM users WHERE user_id=? AND role='lab' AND username<>'lab'`,[req.params.id]);res.json({ok:true})}));
app.get('/api/admin/nurses',adm,wrap(async(req,res)=>res.json(await Q(`SELECT nurse_id,first_name,last_name,phone_number FROM nurses WHERE employment_status='Active' ORDER BY last_name`))));
app.post('/api/admin/nurses',adm,wrap(async(req,res)=>{
  const b=req.body;if(!b.first_name||!b.last_name||!['Male','Female'].includes(b.gender))throw bad('Name and gender are required');
  await Q('INSERT INTO nurses(first_name,last_name,gender,phone_number,email,department_id,qualification) VALUES(?,?,?,?,?,1,?)',[b.first_name,b.last_name,b.gender,b.phone_number||null,(b.email||'').trim()||null,b.qualification||null]);res.json({ok:true});
}));
app.get('/api/admin/nurse-roster',adm,wrap(async(req,res)=>res.json(await Q(`SELECT nd.duty_id,nd.duty_date,nd.shift,CONCAT(n.first_name,' ',n.last_name) nurse FROM nurse_duty nd JOIN nurses n USING(nurse_id) WHERE nd.duty_date>=? ORDER BY nd.duty_date,nd.shift`,[today()]))));
app.post('/api/admin/nurse-roster',adm,wrap(async(req,res)=>{
  const {nurse_id,date,shift}=req.body;if(!isDate(date)||date<today()||!['Morning','Afternoon','Night'].includes(shift))throw bad('Check the date and shift');
  await Q('INSERT INTO nurse_duty(nurse_id,duty_date,shift) VALUES(?,?,?) ON DUPLICATE KEY UPDATE shift=VALUES(shift)',[nurse_id,date,shift]);res.json({ok:true});
}));
app.delete('/api/admin/nurse-roster/:id',adm,wrap(async(req,res)=>{await Q('DELETE FROM nurse_duty WHERE duty_id=?',[req.params.id]);res.json({ok:true})}));

async function init(){
  await db.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
  const mk=async(u,p,role,ref)=>{if(!(await Q('SELECT 1 FROM users WHERE username=?',[u])).length)await Q('INSERT INTO users(username,password_hash,role,ref_id) VALUES(?,?,?,?)',[u,await bcrypt.hash(p,10),role,ref])};
  await mk('admin',process.env.ADMIN_PASSWORD||'admin12345','admin',null);
  await mk('lab',process.env.LAB_PASSWORD||'lab12345','lab',1);
  for(const d of await Q('SELECT doctor_id,email FROM doctors WHERE email IS NOT NULL'))await mk(d.email.toLowerCase(),process.env.DOCTOR_DEFAULT_PASSWORD||'doctor12345','doctor',d.doctor_id);
}
init().then(()=>app.listen(process.env.PORT||3000,()=>console.log('Running on http://localhost:'+(process.env.PORT||3000)))).catch(e=>{console.error('Startup failed:',e.message);process.exit(1)});
