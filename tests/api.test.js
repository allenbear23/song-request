const request = require('supertest');
const app = require('../server');

describe('Song Request API', () => {
    it('GET /health should return connected or disconnected db status', async () => {
        const res = await request(app).get('/health');
        expect(res.statusCode).toEqual(200);
        expect(res.body).toHaveProperty('ok', true);
        expect(res.body).toHaveProperty('db');
    });

    it('GET /settings should return default settings for default room', async () => {
        const res = await request(app).get('/settings');
        expect(res.statusCode).toEqual(200);
        expect(res.body).toHaveProperty('threshold');
        expect(res.body).toHaveProperty('timeout');
        expect(res.body).toHaveProperty('banDuration');
        expect(res.body).toHaveProperty('autoQueue');
        expect(res.body).toHaveProperty('volume');
        expect(res.body).toHaveProperty('readAloud');
        expect(res.body).toHaveProperty('strictMusicOnly');
    });

    it('POST /admin/read-aloud should update readAloud setting', async () => {
        const res = await request(app)
            .post('/admin/read-aloud')
            .send({ enabled: true });
        expect(res.statusCode).toEqual(200);
        expect(res.body).toHaveProperty('readAloud', true);

        const settingsRes = await request(app).get('/settings');
        expect(settingsRes.body.readAloud).toBe(true);
    });

    it('POST /admin/strict-music should update strictMusicOnly setting', async () => {
        const res = await request(app)
            .post('/admin/strict-music')
            .send({ enabled: true });
        expect(res.statusCode).toEqual(200);
        expect(res.body).toHaveProperty('strictMusicOnly', true);

        const settingsRes = await request(app).get('/settings');
        expect(settingsRes.body.strictMusicOnly).toBe(true);
    });

    it('GET /queue should return an array', async () => {
        const res = await request(app).get('/queue');
        expect(res.statusCode).toEqual(200);
        expect(Array.isArray(res.body)).toBeTruthy();
    });
});
