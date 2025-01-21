import express from 'express';
import bodyParser from 'body-parser';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import crypto from 'crypto';

const app = express();
const prisma = new PrismaClient();

const PORT = 5001;

// Middleware для обработки JSON
app.use(bodyParser.json());

// Валидация данных через Zod
const userSchema = z.object({
	id: z.string(),
	first_name: z.string(),
	last_name: z.string().optional(),
	username: z.string().optional(),
	language_code: z.string().optional(),
	is_premium: z.boolean().optional()
});

// Проверка подписи Telegram
function verifyTelegramData(data) {
	const secretKey = crypto.createHash('sha256').update(process.env.BOT_TOKEN).digest();

	const sortedData = Object.keys(data)
		.filter((key) => key !== 'hash')
		.sort()
		.map((key) => `${key}=${data[key]}`)
		.join('\n');

	const hmac = crypto.createHmac('sha256', secretKey).update(sortedData).digest('hex');

	return hmac === data.hash;
}

// Роут для сохранения пользователя
app.post('/api/save-user', async (req, res) => {
	try {
		const { initData } = req.body;

		// Парсим данные Telegram
		const data = Object.fromEntries(new URLSearchParams(initData));

		// Проверяем подпись
		if (!verifyTelegramData(data)) {
			return res.status(403).json({ message: 'Invalid Telegram signature' });
		}

		// Валидация данных через Zod
		const validatedUser = userSchema.parse({
			id: data.id,
			first_name: data.first_name,
			last_name: data.last_name,
			username: data.username,
			language_code: data.language_code,
			is_premium: data.is_premium === 'true'
		});

		// Проверяем, существует ли пользователь
		const existingUser = await prisma.user.findUnique({
			where: { telegramId: validatedUser.id }
		});

		if (existingUser) {
			return res.status(200).json({ message: 'User already exists', user: existingUser });
		}

		// Сохраняем нового пользователя
		const newUser = await prisma.user.create({
			data: {
				telegramId: validatedUser.id,
				firstName: validatedUser.first_name,
				lastName: validatedUser.last_name,
				username: validatedUser.username,
				languageCode: validatedUser.language_code,
				isPremium: validatedUser.is_premium
			}
		});

		res.status(201).json({ message: 'User saved successfully', user: newUser });
	} catch (error) {
		console.error(error);
		if (error instanceof z.ZodError) {
			return res.status(400).json({ message: 'Validation error', errors: error.errors });
		}
		res.status(500).json({ message: 'Server error' });
	}
});

// Запуск сервера
app.listen(PORT, () => {
	console.log(`Server is running on http://localhost:${PORT}`);
});
