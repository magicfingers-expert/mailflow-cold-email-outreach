const nodemailer = require('nodemailer');

async function test() {
  console.log('--- Testing Gmail SMTP ---');
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: 'willowwixpartner@gmail.com',
      pass: 'jdedfvcsmicllxrm'
    }
  });

  try {
    console.log('Verifying...');
    await transporter.verify();
    console.log('>>> AUTH OK <<<');
    
    console.log('Sending message to thomashammed3@gmail.com...');
    const info = await transporter.sendMail({
      from: '"Willow Wix Partner" <willowwixpartner@gmail.com>',
      to: 'thomashammed3@gmail.com',
      subject: 'Quick question regarding collaboration',
      text: 'Hi,\n\nI came across your work recently and wanted to reach out directly.\n\nBest regards,\nWillow Wix Partner'
    });
    console.log('>>> DISPATCH OK <<< Message ID:', info.messageId);
    console.log('Server Response:', info.response);
  } catch (err) {
    console.error('>>> DISPATCH FAILED <<<:', err.message);
  }
}

test();
