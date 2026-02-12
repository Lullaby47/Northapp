// services/emailParser.js
// Interface to external Python email parser (Windows-safe)
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");

/**
 * Call external Python email parser with Windows compatibility and timeout
 * @param {string} emailContent - Raw email content
 * @param {string} emailSubject - Email subject
 * @returns {Promise<Object>} - Parsed email data
 */
async function parseEmail(emailContent, emailSubject) {
  console.log(`🐍 [PARSER] Starting Python parser...`);
  console.log(`🐍 [PARSER] Email content length: ${emailContent?.length || 0} bytes`);
  console.log(`🐍 [PARSER] Email subject: ${emailSubject}`);
  console.log(`🐍 [PARSER] Platform: ${os.platform()}`);
  
  return new Promise((resolve, reject) => {
    // Path to Python parser script
    const pythonScript = process.env.EMAIL_PARSER_SCRIPT || path.join(__dirname, "../parser/parse_email.py");
    console.log(`🐍 [PARSER] Python script path: ${pythonScript}`);
    
    // Determine Python command based on platform
    const isWindows = os.platform() === "win32";
    const pythonCmd = isWindows ? "py" : "python3";
    const pythonArgs = isWindows ? ["-3", pythonScript] : [pythonScript];
    
    console.log(`🐍 [PARSER] Python command: ${pythonCmd}`);
    console.log(`🐍 [PARSER] Python args:`, pythonArgs);
    
    // Spawn Python process (NO shell: true for better reliability)
    const python = spawn(pythonCmd, pythonArgs, {
      shell: false, // Don't use shell for better cross-platform compatibility
    });

    let stdout = "";
    let stderr = "";
    let timeoutId = null;

    // Set timeout (15 seconds)
    timeoutId = setTimeout(() => {
      console.log(`🐍 [PARSER] ❌ Timeout after 15 seconds`);
      python.kill();
      reject(new Error(`Python parser timeout after 15 seconds. Stderr: ${stderr.substring(0, 500)}`));
    }, 15000);

    console.log(`🐍 [PARSER] Sending email data to Python script...`);
    // Send email content to Python script via stdin
    const inputData = JSON.stringify({
      content: emailContent,
      subject: emailSubject,
    });
    
    try {
      python.stdin.write(inputData);
      python.stdin.end();
      console.log(`🐍 [PARSER] Input data sent (${inputData.length} bytes)`);
    } catch (e) {
      clearTimeout(timeoutId);
      console.log(`🐍 [PARSER] ❌ Failed to write to stdin: ${e.message}`);
      reject(new Error(`Failed to write to Python stdin: ${e.message}`));
      return;
    }

    python.stdout.on("data", (data) => {
      stdout += data.toString();
      console.log(`🐍 [PARSER] Received stdout chunk: ${data.length} bytes`);
    });

    python.stderr.on("data", (data) => {
      stderr += data.toString();
      console.log(`🐍 [PARSER] Received stderr: ${data.toString().trim()}`);
    });

    python.on("close", (code) => {
      clearTimeout(timeoutId);
      console.log(`🐍 [PARSER] Python process exited with code: ${code}`);
      console.log(`🐍 [PARSER] Total stdout length: ${stdout.length} bytes`);
      console.log(`🐍 [PARSER] Total stderr length: ${stderr.length} bytes`);
      
      if (code !== 0) {
        console.log(`🐍 [PARSER] ❌ Parser failed with exit code ${code}`);
        console.log(`🐍 [PARSER] Full stderr: ${stderr}`);
        console.log(`🐍 [PARSER] First 500 chars of stdout: ${stdout.substring(0, 500)}`);
        reject(new Error(`Python parser exited with code ${code}. Stderr: ${stderr.substring(0, 500)}`));
        return;
      }

      // Clean stdout (remove any stderr that leaked, trim whitespace)
      const cleanStdout = stdout.trim();
      
      if (!cleanStdout) {
        console.log(`🐍 [PARSER] ❌ Empty stdout from Python parser`);
        console.log(`🐍 [PARSER] Stderr: ${stderr}`);
        reject(new Error(`Python parser returned empty output. Stderr: ${stderr.substring(0, 500)}`));
        return;
      }

      try {
        console.log(`🐍 [PARSER] Parsing JSON output...`);
        console.log(`🐍 [PARSER] Raw stdout (first 500 chars): ${cleanStdout.substring(0, 500)}`);
        
        // Try to find JSON in stdout (in case there's extra text)
        let jsonStr = cleanStdout;
        const jsonMatch = cleanStdout.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
          console.log(`🐍 [PARSER] Extracted JSON from stdout`);
        }
        
        const result = JSON.parse(jsonStr);
        
        // Validate required fields
        if (typeof result.amount === "undefined" || typeof result.pay_type === "undefined") {
          console.log(`🐍 [PARSER] ⚠️  Missing required fields in parser result`);
        }
        
        console.log(`🐍 [PARSER] ✅ Parser result:`, JSON.stringify(result, null, 2));
        resolve(result);
      } catch (e) {
        console.log(`🐍 [PARSER] ❌ Failed to parse JSON output: ${e.message}`);
        console.log(`🐍 [PARSER] Raw stdout (first 500 chars): ${cleanStdout.substring(0, 500)}`);
        console.log(`🐍 [PARSER] Full stderr: ${stderr}`);
        reject(new Error(`Failed to parse Python output: ${e.message}. Output: ${cleanStdout.substring(0, 500)}`));
      }
    });

    python.on("error", (err) => {
      clearTimeout(timeoutId);
      console.log(`🐍 [PARSER] ❌ Failed to start Python process: ${err.message}`);
      console.log(`🐍 [PARSER] Command attempted: ${pythonCmd} ${pythonArgs.join(" ")}`);
      reject(new Error(`Failed to start Python parser: ${err.message}. Make sure Python 3 is installed and accessible as '${pythonCmd}'`));
    });
  });
}

module.exports = { parseEmail };

