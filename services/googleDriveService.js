const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Google Drive service for backup uploads
class GoogleDriveService {
  constructor() {
    this.auth = null;
    this.drive = null;
    this.folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || '';
    this.initialized = false;
  }

  // Initialize with service account credentials
  initialize(credentials) {
    try {
      if (!credentials) {
        // Try to load from file
        const credPath = path.join(process.cwd(), 'config', 'google-credentials.json');
        if (fs.existsSync(credPath)) {
          credentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        } else {
          console.warn('Google Drive credentials file not found');
          return false;
        }
      }

      if (!credentials || !credentials.client_email || !credentials.private_key) {
        console.warn('Google Drive credentials not properly configured');
        return false;
      }

      this.auth = new google.auth.GoogleAuth({
        credentials: credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file']
      });

      this.drive = google.drive({ version: 'v3', auth: this.auth });
      this.initialized = true;
      console.log('Google Drive service initialized successfully');
      return true;
    } catch (error) {
      console.error('Failed to initialize Google Drive service:', error);
      return false;
    }
  }

  // Upload file to Google Drive
  async uploadFile(filePath, fileName) {
    if (!this.initialized) {
      throw new Error('Google Drive service not initialized');
    }

    try {
      // Read the file
      const fileContent = fs.readFileSync(filePath);

      // Create file metadata
      const metadata = {
        name: fileName,
        parents: this.folderId ? [this.folderId] : []
      };

      // Upload to Google Drive
      const response = await this.drive.files.create({
        resource: metadata,
        media: {
          body: Buffer.from(fileContent)
        },
        fields: 'id, webViewLink'
      });

      console.log(`File uploaded to Google Drive: ${response.data.id}`);
      return {
        fileId: response.data.id,
        webViewLink: response.data.webViewLink,
        success: true
      };
    } catch (error) {
      console.error('Failed to upload to Google Drive:', error);
      throw error;
    }
  }

  // Download file from Google Drive
  async downloadFile(fileId, destinationPath) {
    if (!this.initialized) {
      throw new Error('Google Drive service not initialized');
    }

    try {
      const response = await this.drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
      );

      return new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(destinationPath);
        response.data
          .on('end', () => {
            console.log(`File downloaded from Google Drive: ${fileId}`);
            resolve(destinationPath);
          })
          .on('error', (err) => {
            console.error('Error downloading from Google Drive:', err);
            reject(err);
          })
          .pipe(writeStream);
      });
    } catch (error) {
      console.error('Failed to download from Google Drive:', error);
      throw error;
    }
  }

  // Delete file from Google Drive
  async deleteFile(fileId) {
    if (!this.initialized) {
      throw new Error('Google Drive service not initialized');
    }

    try {
      await this.drive.files.delete({ fileId });
      console.log(`File deleted from Google Drive: ${fileId}`);
      return { success: true };
    } catch (error) {
      console.error('Failed to delete from Google Drive:', error);
      throw error;
    }
  }

  // List files in the folder
  async listFiles() {
    if (!this.initialized) {
      throw new Error('Google Drive service not initialized');
    }

    try {
      const response = await this.drive.files.list({
        q: this.folderId ? `'${this.folderId}' in parents` : "'root' in parents",
        fields: 'files(id, name, createdTime, size)'
      });

      return response.data.files || [];
    } catch (error) {
      console.error('Failed to list Google Drive files:', error);
      throw error;
    }
  }

  // Check if service is initialized
  isReady() {
    return this.initialized;
  }
}

module.exports = new GoogleDriveService();
