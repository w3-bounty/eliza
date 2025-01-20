import { createCipheriv, createDecipheriv, randomBytes, scrypt, createHash } from 'crypto';
import { promisify } from 'util';
import { networkInterfaces, hostname, platform, arch, cpus } from 'os';
import { elizaLogger } from '@elizaos/core';

export class EncryptionService {
    private static instance: EncryptionService;
    private readonly algorithm = 'aes-256-gcm';
    private readonly keyLength = 32;
    private encryptionKey: Buffer | null = null;

    private constructor() {}

    public static getInstance(): EncryptionService {
        if (!EncryptionService.instance) {
            EncryptionService.instance = new EncryptionService();
        }
        return EncryptionService.instance;
    }

    private getMachineSpecificId(): string {
        try {
            // Get only stable system-specific information
            const systemInfo = {
                hostname: hostname(),
                platform: platform(),
                arch: arch(),
                cpuModel: cpus()[0]?.model || ''
            };

            // Get MAC address
            const nets = networkInterfaces();
            let macAddress = '';
            for (const name of Object.keys(nets)) {
                const net = nets[name];
                if (net) {
                    for (const interface_ of net) {
                        if (!interface_.internal && interface_.mac !== '00:00:00:00:00:00') {
                            macAddress = interface_.mac;
                            break;
                        }
                    }
                }
                if (macAddress) break;
            }

            // Create a hash of stable system information
            const hash = createHash('sha256');
            hash.update(JSON.stringify(systemInfo));
            hash.update(macAddress);

            return hash.digest('hex');
        } catch (error) {
            elizaLogger.error(`Failed to get machine specific ID: ${error.message}`);
            // Use a more stable fallback that's consistent within the same day
            const today = new Date().toISOString().split('T')[0];
            return createHash('sha256').update(`fallback-${today}`).digest('hex');
        }
    }

    public async initialize(customSalt?: string): Promise<void> {
        const machineId = this.getMachineSpecificId();
        const salt = customSalt || 'elizaos_salt';

        // Combine machine ID with salt for key generation
        const keyMaterial = `${machineId}-${salt}`;

        // Generate key using scrypt
        this.encryptionKey = await promisify(scrypt)(keyMaterial, salt, this.keyLength) as Buffer;

        elizaLogger.debug('Encryption service initialized with machine-specific key');
    }

    public async encrypt(text: string): Promise<string> {
        if (!this.encryptionKey) {
            throw new Error('Encryption service not initialized');
        }

        // Generate initialization vector
        const iv = randomBytes(16);

        // Create cipher
        const cipher = createCipheriv(this.algorithm, this.encryptionKey, iv);

        // Encrypt the text
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');

        // Get auth tag
        const authTag = cipher.getAuthTag();

        // Combine IV, encrypted text and auth tag
        return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
    }

    public async decrypt(encryptedData: string): Promise<string> {
        if (!this.encryptionKey) {
            throw new Error('Encryption service not initialized');
        }

        // Split the stored data
        const [ivHex, authTagHex, encryptedText] = encryptedData.split(':');

        // Convert hex strings back to buffers
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');

        // Create decipher
        const decipher = createDecipheriv(this.algorithm, this.encryptionKey, iv);
        decipher.setAuthTag(authTag);

        // Decrypt the text
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    }
}