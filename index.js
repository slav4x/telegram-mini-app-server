import express from 'express';
import bodyParser from 'body-parser';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import crypto from 'crypto';
import cors from 'cors';

const app = express();
const prisma = new PrismaClient();

const PORT = 3000;

// Настрой CORS
app.use(
	cors({
		origin: 'https://slav4x-telegram-mini-app-dbaa.twc1.net', // Домен твоего фронтенда
		methods: ['GET', 'POST'], // Разрешённые методы
		credentials: true // Если требуется передавать куки
	})
);

// Проверка соединения с базой данных
(async () => {
	try {
		await prisma.$connect();
		console.log('Database connected successfully');
	} catch (error) {
		console.error('Database connection error:', error);
		process.exit(1); // Завершаем процесс, если подключение не удалось
	}
})();

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
	if (!process.env.BOT_TOKEN) {
		throw new Error('BOT_TOKEN is not defined in environment variables.');
	}

	const botToken = process.env.BOT_TOKEN;

	// Генерация секретного ключа
	const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();

	// Формирование data-check-string
	const dataCheckString = Object.keys(data)
		.filter((key) => key !== 'hash') // Исключаем "hash"
		.sort() // Сортируем поля
		.map((key) => `${key}=${data[key]}`) // Формат key=value
		.join('\n'); // Разделяем через \n

	// Генерация HMAC для data-check-string
	const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

	console.log('Data-check-string:', dataCheckString);
	console.log('Calculated HMAC:', hmac);
	console.log('Received hash:', data.hash);

	// Сравнение рассчитанного HMAC с полученным hash
	return hmac === data.hash;
}

// Роут для сохранения пользователя
app.post('/api/save-user', async (req, res) => {
	try {
		const { initData } = req.body;

		if (!initData) {
			return res.status(400).json({ message: 'initData is missing' });
		}

		const data = Object.fromEntries(new URLSearchParams(initData));

		if (!verifyTelegramData(data)) {
			return res.status(403).json({ message: 'Invalid Telegram signature' });
		}

		const user = JSON.parse(data.user);

		// Валидация данных пользователя
		const validatedUser = userSchema.parse({
			id: String(user.id),
			first_name: data.user ? JSON.parse(data.user).first_name : undefined,
			last_name: data.user ? JSON.parse(data.user).last_name : undefined,
			username: data.user ? JSON.parse(data.user).username : undefined,
			language_code: data.user ? JSON.parse(data.user).language_code : undefined,
			is_premium: data.user ? JSON.parse(data.user).is_premium : false
		});

		console.log('Validated user:', validatedUser);

		// Проверяем, существует ли пользователь
		const existingUser = await prisma.users.findUnique({
			where: { telegramId: validatedUser.id }
		});

		if (existingUser) {
			console.log('User already exists:', existingUser);

			await prisma.users.update({
				where: { telegramId: validatedUser.id },
				data: {}
			});

			return res.status(200).json({ message: 'User already exists', user: existingUser });
		}

		// Создаём нового пользователя
		const newUser = await prisma.users.create({
			data: {
				telegramId: validatedUser.id,
				firstName: validatedUser.first_name,
				lastName: validatedUser.last_name,
				username: validatedUser.username,
				languageCode: validatedUser.language_code,
				isPremium: validatedUser.is_premium,
				balance: 0
			}
		});

		console.log('User created:', newUser);

		res.status(201).json({ message: 'User saved successfully', user: newUser });
	} catch (error) {
		console.error('Error processing request:', error);

		if (error instanceof z.ZodError) {
			return res.status(400).json({ message: 'Validation error', errors: error.errors });
		}

		res.status(500).json({ message: 'Server error' });
	}
});

// Валидация данных для обновления баланса через Zod
const schema = z.object({
	telegramId: z.union([z.string(), z.number()]), // Принимает строку или число
	amount: z.number().int()
});

app.post('/api/update-balance', async (req, res) => {
	try {
		// Валидация тела запроса
		const { telegramId, amount } = schema.parse(req.body);

		// Используем транзакцию для атомарного обновления
		const updatedUser = await prisma.$transaction(async (transaction) => {
			// Найти пользователя
			const user = await transaction.users.findUnique({
				where: { telegramId: String(telegramId) }
			});

			if (!user) {
				throw new Error('User not found');
			}

			// Обновить баланс
			return await transaction.users.update({
				where: { telegramId: String(telegramId) },
				data: { balance: { increment: amount } }
			});
		});

		// Успешный ответ
		res.status(200).json({
			message: 'Balance updated successfully',
			user: updatedUser
		});
	} catch (error) {
		console.error('Error in update-balance:', error);

		// Если ошибка валидации Zod
		if (error instanceof z.ZodError) {
			return res.status(400).json({ message: 'Validation error', errors: error.errors });
		}

		res.status(500).json({ message: 'Server error' });
	}
});

app.get('/api/get-user', async (req, res) => {
	try {
		const { telegramId } = req.query;

		if (!telegramId) {
			return res.status(400).json({ message: 'Telegram ID is required' });
		}

		const user = await prisma.users.findUnique({
			where: { telegramId }
		});

		if (!user) {
			return res.status(404).json({ message: 'User not found' });
		}

		res.status(200).json(user);
	} catch (error) {
		console.error('Error fetching user:', error);
		res.status(500).json({ message: 'Server error' });
	}
});

app.get('/api/get-leaderboard', async (req, res) => {
	try {
		const { telegramId } = req.query;

		console.log('Received telegramId:', telegramId);

		if (!telegramId) {
			return res.status(400).json({ message: 'Telegram ID is required' });
		}

		// Получаем первых 100 пользователей с максимальным балансом
		const leaderboardUsers = await prisma.users.findMany({
			orderBy: {
				balance: 'desc'
			},
			take: 100,
			select: {
				firstName: true,
				lastName: true,
				balance: true
			}
		});

		// Формируем результат с нумерацией
		const leaderboard = leaderboardUsers.map((user, index) => ({
			id: String(index + 1).padStart(3, '0'), // Форматируем ID в виде 001, 002, ...
			name: `${user.firstName} ${user.lastName || ''}`.trim(), // Полное имя
			balance: user.balance
		}));

		// Определяем позицию текущего пользователя
		const userPosition = await prisma.users.findUnique({
			where: { telegramId: String(telegramId) },
			select: { balance: true }
		});

		if (!userPosition) {
			return res.status(404).json({ message: 'User not found' });
		}

		// Теперь можно безопасно обратиться к userPosition.balance
		const position = await prisma.users.count({
			where: {
				balance: {
					gte: userPosition.balance // Количество игроков с балансом больше или равным текущему
				}
			}
		});

		// Получаем общее количество пользователей
		const totalUsers = await prisma.users.count();

		// Формируем ответ
		res.status(200).json({
			leaderboard,
			currentUserPosition: {
				position,
				balance: userPosition.balance
			},
			totalUsers
		});
	} catch (error) {
		console.error('Error in get-leaderboard:', error);
		res.status(500).json({ message: 'Server error' });
	}
});

// Запуск сервера
app.listen(PORT, () => {
	console.log(`Server is running on http://localhost:${PORT}`);
});
