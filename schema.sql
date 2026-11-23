CREATE TABLE IF NOT EXISTS users(user_id INT AUTO_INCREMENT PRIMARY KEY,username VARCHAR(100) UNIQUE NOT NULL,password_hash VARCHAR(100) NOT NULL,role ENUM('patient','doctor','lab','admin') NOT NULL,ref_id INT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS duty_roster(roster_id INT AUTO_INCREMENT PRIMARY KEY,doctor_id INT NOT NULL,duty_date DATE NOT NULL,start_time TIME NOT NULL,end_time TIME NOT NULL,UNIQUE(doctor_id,duty_date),FOREIGN KEY(doctor_id) REFERENCES doctors(doctor_id));
ALTER TABLE lab_results ADD COLUMN IF NOT EXISTS test_time TIME NULL;
ALTER TABLE lab_results MODIFY test_status ENUM('Pending','Processing','Completed','Cancelled') DEFAULT 'Pending';
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(100) NULL;
CREATE TABLE IF NOT EXISTS nurse_duty(duty_id INT AUTO_INCREMENT PRIMARY KEY,nurse_id INT NOT NULL,duty_date DATE NOT NULL,shift ENUM('Morning','Afternoon','Night') NOT NULL,UNIQUE(nurse_id,duty_date),FOREIGN KEY(nurse_id) REFERENCES nurses(nurse_id));
