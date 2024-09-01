/*

  /update_user_balance ${user_id} ${amount}                 - пополнение баланса с админ панельки
  /send_police_to_user ${user_id} ${car_id} ${policy_id}    - отправка полиса с сохранением в базе

  Every day at 8 am we run checkAndUpdateExpiredPolicies()  - напоминание об истичение полиса/апдейт статуса полиса
*/

require("dotenv").config();
const { Telegraf } = require("telegraf");
const { MongoClient, ObjectId, GridFSBucket } = require("mongodb");
const { Readable } = require('stream');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const TOKEN = process.env.TOKEN;
const url = process.env.MONGODB_URL;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const bot = new Telegraf(TOKEN);
const client = new MongoClient(url);

const priceList = [
  { duration: "1 месяц", cost: 140, callback_data: "buy_policy_1_month" },
  { duration: "3 месяца", cost: 390, callback_data: "buy_policy_3_months" },
];

let canAnswer = false;

client
  .connect()
  .then(() => {
    console.log("Connected to MongoDB");

    const db = client.db("car_insurance");
    const usersCollection = db.collection("users");
    const carsCollection = db.collection("cars");
    const policiesCollection = db.collection("policies");
    const bucket = new GridFSBucket(client.db('car_insurance'));

    const userStates = new Map();

    function formatDate(date) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${day}.${month}.${year}`;
    }

    function getStartDate() {
      return new Date();
    }

    function getExpirationDate(startDate, monthsDuration) {
      const expirationDate = new Date(startDate);
      expirationDate.setMonth(expirationDate.getMonth() + monthsDuration);
      return expirationDate;
    }

    async function myGarage(ctx) {
      userStates.delete(ctx.from.id);
      const userId = ctx.from.id;
      const user = await usersCollection.findOne({ id: userId });

      if (user) {
        ctx.reply(
          `Мой гараж 🚘 \nИмя пользователя: ${user.username}\nID пользователя: ${user.id}\nБаланс: ${user.balance} PLN`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "Добавить автомобиль", callback_data: "add_car" }],
                [{ text: "Пополнить баланс", callback_data: "add_balance" }],
              ],
            },
          }
        );

        const cars = await carsCollection.find({ user_id: userId }).toArray();
        cars.forEach((car) => {
          ctx.reply(`🚙 ${car.car_info}`, {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Aктивные полисы",
                    callback_data: `view_policies_${car._id}`,
                  },
                ],
                [
                  {
                    text: "Архив полисов",
                    callback_data: `archived_policies_${car._id}`,
                  },
                ],
                [
                  {
                    text: "Удалить автомобиль",
                    callback_data: `delete_car_${car._id}`,
                  },
                ],
              ],
            },
          });
        });
      } else {
        await usersCollection.insertOne({
          id: userId,
          username: ctx.from.username,
          balance: 0,
        });
        ctx.reply("Ваш гараж пуст. Добавьте автомобиль, чтобы продолжить.", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Добавить автомобиль", callback_data: "add_car" }],
            ],
          },
        });
      }
      canAnswer = true;
    }

    function addBalance(ctx) {
      userStates.delete(ctx.from.id);
      ctx.reply("Выберите способ оплаты", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Blik на номер 📱", callback_data: "blik_phone" }],
            [
              {
                text: "Быстрый банковкий перевод 🏦",
                callback_data: "bank_iban",
              },
            ],
          ],
        },
      });
    }

    async function createPolis(ctx) {
      userStates.delete(ctx.from.id);
      const userId = ctx.from.id;
      const cars = await carsCollection.find({ user_id: userId }).toArray();

      if (cars.length === 0) {
        ctx.reply("Ваш гараж пуст. Добавьте автомобиль, чтобы продолжить.", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Добавить автомобиль", callback_data: "add_car" }],
            ],
          },
        });
      } else {
        const buttons = cars.map((car) => [
          {
            text: `Выбрать: ${car.car_info}`,
            callback_data: `select_car_${car._id}`,
          },
        ]);
        ctx.reply("Выберите автомобиль для полиса:", {
          reply_markup: {
            inline_keyboard: buttons,
          },
        });
      }
      canAnswer = true;
    }

    function support(ctx) {
      userStates.delete(ctx.from.id);
      ctx.reply("Напишите в нашу службу поддержки @vlcontact");
      canAnswer = true;
    }

    function aboutUs(ctx) {
      userStates.delete(ctx.from.id);
      ctx.reply(
        `Мы предоставляем удобные и гибкие решения для краткосрочного страхования автомобилей. Наша цель - сделать процесс страхования быстрым и простым, чтобы вы могли без лишних хлопот защитить себя и свой автомобиль на нужный вам срок. Наши преимущества:

        - Гибкие сроки: выберите период страхования от 1 до 3 месяцев.
        - Быстрое оформление: получите полис в несколько шагов через нашего бота.
        - Прозрачные условия: никаких скрытых платежей и неожиданностей.
        - Поддержка 24/7: наши специалисты всегда готовы помочь вам.

        Оформите краткосрочное страхование прямо сейчас и будьте уверены в своей безопасности на дороге!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Сделать полис 📃", callback_data: "create_polis" }],
              [{ text: "Добавить автомобиль 🚙", callback_data: "add_car" }],
            ],
          },
        }
      );
      canAnswer = true;
    }

    function start(ctx) {
      userStates.delete(ctx.from.id);
      ctx.reply(
        "Привет! Я ваш бот по страхованию автомобилей. Готов помочь вам оформить полис за считанные минуты. \nВыберите действие:",
        {
          reply_markup: {
            keyboard: [
              [{ text: "Мой гараж 🚘" }],
              [{ text: "Пополнение 💸" }, { text: "Сделать полис 📃" }],
              [{ text: "Консультант 🧑‍💼" }, { text: "О нас ℹ️" }],
            ],
            resize_keyboard: true,
          },
        }
      );
      canAnswer = true;
    }

    async function sendPolicyToUser(ctx, userId, carId, policyID, caption) {
      try {
          const policyIDToString = policyID.toString();
          const policy = await policiesCollection.findOne({
              user_id: userId,
              car_id: carId,
              policy_id: policyIDToString,
          });
  
          if (!policy) {
              return ctx.reply("Файл полиса не найден.\n" + caption);
          }
  
          const fileId = policy.file_id;
          const fileObjectId = new ObjectId(fileId);
          const downloadStream = bucket.openDownloadStream(fileObjectId);
          const filePath = path.join('/tmp', `policy_${userId}_${carId}_${policyIDToString}.pdf`);
          const writableStream = fs.createWriteStream(filePath);
          downloadStream.pipe(writableStream);
  
          writableStream.on('finish', async () => {
              try {
                  await bot.telegram.sendDocument(userId, { source: filePath }, {caption});
                  // Delete the temporary file after sending
                  fs.unlink(filePath, (err) => {
                      if (err) {
                          console.error('Ошибка при удалении временного файла:', err.message);
                      }
                  });
  
              } catch (sendError) {
                  console.error('Ошибка при отправке документа:', sendError.message);
                  ctx.reply('Произошла ошибка при отправке документа.');
              }
          });
  
          writableStream.on('error', (writeError) => {
              console.error('Ошибка при записи файла:', writeError.message);
              ctx.reply('Произошла ошибка при обработке документа.');
          });
  
          downloadStream.on('error', (downloadError) => {
              console.error('Ошибка при скачивании из GridFS:', downloadError.message);
              ctx.reply('Произошла ошибка при скачивании документа.');
          });
      } catch (error) {
          console.error("Ошибка при отправке полиса:", error.message);
          ctx.reply("Произошла ошибка при отправке полиса. Проверьте логи для получения дополнительной информации.");
      }
  }

    // ----- BOT

    bot.start((ctx) => {
      start(ctx);
      console.log(`start: ${ctx.message.text}`);
    });

    bot.hears("Мой гараж 🚘", (ctx) => {
      canAnswer = false;
      myGarage(ctx);
      console.log(`My garage: ${ctx.message.text}`);
    });

    bot.hears("Пополнение 💸", (ctx) => {
      canAnswer = false;
      addBalance(ctx);
      console.log(`Пополнение: ${ctx.message.text}`);
    });

    bot.hears("Сделать полис 📃", async (ctx) => {
      createPolis(ctx);
      console.log(`Сделать полис: ${ctx.message.text}`);
    });

    bot.hears("Консультант 🧑‍💼", async (ctx) => {
      support(ctx);
      console.log(`Консультант: ${ctx.message.text}`);
    });

    bot.hears("О нас ℹ️", async (ctx) => {
      aboutUs(ctx);
      console.log(`About us: ${ctx.message.text}`);
    });

    bot.command('update_user_balance', async (ctx) => {
      if (ctx.chat.id === Number(ADMIN_CHAT_ID)) {
        const text = ctx.message.text.trim();
        const [command, userId, amount] = text.split(' ');

        if (!userId || !amount) {
          return ctx.reply('Неверный формат команды. Используйте: /update_user_balance id сумма');
        }

        const userIdNum = parseInt(userId);
        const amountNum = parseFloat(amount);

        if (isNaN(userIdNum) || isNaN(amountNum) || amountNum <= 0) {
          return ctx.reply('ID и сумма должны быть положительными числами.');
        }

        try {
          const user = await usersCollection.findOne({ id: userIdNum });

          if (user) {
            await usersCollection.updateOne(
              { id: userIdNum },
              { $inc: { balance: amountNum } }
            );

            ctx.reply(`Баланс пользователя ${userIdNum} успешно пополнен на ${amountNum} PLN.`);

            await bot.telegram.sendMessage(userIdNum, `Ваш баланс был пополнен на ${amountNum} PLN.`);
          } else {
            ctx.reply(`Пользователь c ID ${userIdNum} не найден.`);
          }
        } catch (error) {
          console.error('Ошибка при пополнении баланса:', error);
          ctx.reply('Произошла ошибка при пополнении баланса.');
        }
      } else {
        ctx.reply('Эта команда доступна только в указанной группе.');
      }
    });

    bot.on("callback_query", async (ctx) => {
      const data = ctx.callbackQuery.data;
      const userId = ctx.from.id;

      if (data === "add_car") {
        ctx.reply(
          "Пожалуйста, введите марку, модель и регистрационный номер автомобиля в формате: \nBMW 318i ABC12345"
        );
        userStates.set(userId, "waiting_for_car_info");
      } else if (data === "add_balance") {
        ctx.reply("Выберите способ оплаты", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Blik на номер 📱", callback_data: "blik_phone" }],
              [
                {
                  text: "Быстрый банковкий перевод 🏦",
                  callback_data: "bank_iban",
                },
              ],
            ],
          },
        });
      } else if (data === "blik_phone") {
        ctx.reply(
          `Пожалуйста, сделайте перевод на номер +48777777777 в титуле перевода укажите свой 🆔: ${ctx.chat.id} \n\nЗатем отправьте PDF файл или скрин шот подтверждение платежа. `
        );
      } else if (data === "bank_iban") {
        ctx.reply(`Пожалуйста, сделайте быстрый перевод на данный номер счета PLiban.
В титуле перевода укажите свой 🆔: ${ctx.chat.id} \n\nВажно  🚨 во избежания долгого зачисления баланса на счет обязательно убедитесь что делаете быстрый перевод и отправьте PDF файл или скрин шот подтверждение платежа.`);
      } else if (data.startsWith("select_car_")) {
        const carId = data.split("_")[2];
        userStates.set(userId, `waiting_for_policy_duration_${carId}`);

        const buttons = priceList.map((price) => [
          {
            text: `${price.duration} - ${price.cost} PLN`,
            callback_data: `${price.callback_data}_${carId}`,
          },
        ]);

        ctx.reply("На какой срок сделать полис?", {
          reply_markup: {
            inline_keyboard: buttons,
          },
        });
      } else if (data.startsWith("buy_policy_")) {
        const parts = data.split("_");
        const duration = `${parts[2]}_${parts[3]}`;
        const carId = parts[4];
        const selectedPrice = priceList.find(
          (price) => price.callback_data === `buy_policy_${duration}`
        );
        const cost = selectedPrice ? selectedPrice.cost : null;

        if (cost === null) {
          ctx.reply("Произошла ошибка. Попробуйте снова.");
          return;
        }

        // Fetch the updated user data
        const user = await usersCollection.findOne({ id: userId });

        if (user.balance >= cost) {
          await usersCollection.updateOne(
            { id: userId },
            { $inc: { balance: -cost } }
          );

          const policyID = new ObjectId();
          const car = await carsCollection.findOne({_id: ObjectId.createFromHexString(carId)});

          let startDate = getStartDate();
          let expirationDate = getExpirationDate(startDate, parseInt(duration.split(" ")[0]));
          let policyStatus = 'active'; 

          if (car && car.policies && car.policies.length > 0) {
              const activePolicyExists = car.policies.find(policy => 
                  policy.status === 'active' && new Date(policy.date_of_expiration) > new Date()
              );

              if (activePolicyExists) {
                policyStatus = 'pending';
                startDate = activePolicyExists.date_of_expiration;
                expirationDate = getExpirationDate(activePolicyExists.date_of_expiration, parseInt(duration.split(" ")[0]));
              }
          }

          await carsCollection.updateOne(
            { _id: ObjectId.createFromHexString(carId) },
            {
              $push: {
                policies: {
                  id: policyID,
                  status: policyStatus,
                  date_of_start: startDate,
                  date_of_expiration: expirationDate,
                },
              },
            }
          );

          ctx.reply("Запрос принят, вы получите уведомление как только полис будет готов.");
          bot.telegram.sendMessage(
            ADMIN_CHAT_ID,
            `Пользователь @${user.username} заказал полис. \n\nАвтомобиль: ${car.car_info} \nСрок полиса в месяцах: ${duration} \nДанные с базы: \nuser_id: ${user.id} \ncar_id: ${carId} \npolicy_id: ${policyID}`
          );
        } else {
          ctx.reply(
            `Недостаточно средств на балансе. Ваш баланс ${user.balance}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "Пополнить баланс", callback_data: "add_balance" }],
                ],
              },
            }
          );
        }
      } else if (data.startsWith("delete_car_")) {
        const carId = data.split("_")[2];
        const car = await carsCollection.findOne({
          _id: ObjectId.createFromHexString(carId),
        });
        await carsCollection.deleteOne({
          _id: ObjectId.createFromHexString(carId),
        });
        ctx.reply(`Автомобиль ${car.car_info} удален из вашего гаража.`);
      } else if (data === "my_garage") {
        myGarage(ctx);
      } else if (data === "create_polis") {
        createPolis(ctx);
      } else if (data === "support") {
        support(ctx);
      } else if (data === "about_us") {
        aboutUs(ctx);
      } else if (data.startsWith("view_policies_")) {
        const carId = data.split("_")[2];
        const car = await carsCollection.findOne({_id: ObjectId.createFromHexString(carId)});

        if (car && car.policies && car.policies.length > 0) {
          const activePolicies = car.policies.filter(p => p.status === 'active' || p.status === 'pending');

          await ctx.reply(`🚙 Все ваши активные/в ожидании полисы на автомобиль.`);

          const messagePromises = activePolicies.map(async (policy) => {
              const policyID = policy?.id || null;
              const status = policy.status === 'active' ? "Активный" : policy.status === 'pending' ? 'В ожидании применения' : "Неактивный";
              const startDate = formatDate(new Date(policy.date_of_start));
              const expirationDate = formatDate(new Date(policy.date_of_expiration));

              // Send policy PDF document
              if (policyID) {
                await sendPolicyToUser(
                  ctx,
                  car.user_id,
                  carId, 
                  policyID,
                  `🚙 ${car.car_info} \nСтатус: ${status}\nДата начала действия: ${startDate}\nДата истечения: ${expirationDate}`
                );
              } else {
                // Send policy information
                await ctx.reply(
                  `🚙 Файл полюса не найден.\n ${car.car_info} \nСтатус: ${status}\nДата начала действия: ${startDate}\nДата истечения: ${expirationDate}`
                );
              }
          });
          
          await Promise.all(messagePromises);

        } else {
          ctx.reply(`Полисы для автомобиля ${car.car_info} отсутствуют.`);
        }
      } else if (data.startsWith("archived_policies_")) {
        const carId = data.split("_")[2];
        const car = await carsCollection.findOne({
          _id: ObjectId.createFromHexString(carId),
        });

        if (car && car.policies && car.policies.length > 0) {
          const archivedPolicies = car.policies.filter(p => p.status === 'archived');

          await ctx.reply(`🚙 Все ваши неактивные полисы на автомобиль.`);

          const messagePromises = archivedPolicies.map(async (policy) => {
              const status = "Неактивный";
              const startDate = formatDate(new Date(policy.date_of_start));
              const expirationDate = formatDate(new Date(policy.date_of_expiration));

              await ctx.reply(
                  `🚙 ${car.car_info} \nСтатус: ${status}\nДата начала действия: ${startDate}\nДата истечения: ${expirationDate}`
              );
          });

          await Promise.all(messagePromises);

        } else {
          ctx.reply(`Полисы для автомобиля ${car.car_info} отсутствуют.`);
        }
      }

      canAnswer = true;
    });

    bot.on("text", async (ctx) => {
      console.log('text', JSON.stringify(ctx));
      const userId = ctx.from.id;
      const state = userStates.get(userId);

      if (state === "waiting_for_car_info") {
        const carInfo = ctx.message.text;
        await carsCollection.insertOne({
          user_id: userId,
          car_info: carInfo,
          policies: [],
        });
        ctx.reply(`Автомобиль ${carInfo} добавлен в ваш гараж.`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Сделать полис 📃", callback_data: "create_polis" }],
              [{ text: "Добавить еще один 🚙", callback_data: "add_car" }],
            ],
          },
        });
        userStates.delete(userId);
      } else if (ctx.text.trim() && canAnswer) {
        ctx.reply("Пожалуйста выберите действие из списка:", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Мой гараж 🚘", callback_data: "my_garage" }],
              [{ text: "Пополнение 💸", callback_data: "add_balance" }],
              [{ text: "Сделать полис 📃", callback_data: "create_polis" }],
              [{ text: "Консультант 🧑‍💼", callback_data: "support" }],
              [{ text: "О нас ℹ️", callback_data: "about_us" }],
            ],
          },
        });
      } else if (!canAnswer && ctx.message != "/start") {
        start(ctx);
      }
    });

    const userPhotoMap = new Map(); // Карта для хранения соответствий fileId и userId

    bot.on("photo", async (ctx) => {
      const userId = ctx.from.id;
      const photo = ctx.message.photo.pop(); // Получает последнюю (обычно наибольшего разрешения) фотографию
      const fileId = photo.file_id;

      // Сохраняем соответствие fileId и userId
      userPhotoMap.set(fileId, userId);

      // Отправляем фотографию в канал
      await ctx.telegram.sendPhoto(ADMIN_CHAT_ID, fileId, {
        caption: `Фотография от пользователя @${ctx.from.username} 🆔: ${userId}`,
      });
      ctx.reply("Спасибо за отправленную фотографию!");
    });

    bot.on('document', async (ctx) => {
      console.log('Received document:', ctx);
    
      const document = ctx.message.document;
      const text = ctx.message.caption || '';
    
      if (text.startsWith('/send_police_to_user')) {
        const args = text.split(' ');
    
        if (args.length < 4) {
          return ctx.reply("Используйте команду в формате: /send_police_to_user <user_id> <car_id> <policy_id>");
        }

        const userId = parseInt(args[1], 10);
        const carId = args[2];
        const policyID = args[3];
    
        if (isNaN(userId)) {
          return ctx.reply("Неверный формат user_id.");
        }

        if (!carId) {
          return ctx.reply("Не указан car_id.");
        }

        if (!policyID) {
          return ctx.reply("Не указан policy_id.");
        }
    
        const fileId = document.file_id;
        if (!fileId) {
          return ctx.reply("Не указан file_id.");
        }
    
        try {
          const fileLink = await bot.telegram.getFileLink(fileId);
          const fileStream = await fetch(fileLink).then(res => res.body); // Use fetch to get the file stream
          const readableStream = Readable.from(fileStream);
    
          const uploadStream = bucket.openUploadStream(`policy_${userId}_${carId}_${policyID}.pdf`);
          readableStream.pipe(uploadStream);
    
          uploadStream.on('finish', async () => {
            const car = await carsCollection.findOne({
              _id: ObjectId.createFromHexString(carId),
            });
            await client.db("car_insurance").collection("policies").insertOne({
              user_id: userId,
              car_id: carId,
              policy_id: policyID,
              file_id: uploadStream.id.toString(),
              filename: `policy_${userId}_${carId}_${policyID}.pdf`,
              uploadDate: new Date(),
            });
    
            await bot.telegram.sendDocument(userId, document.file_id, {
              caption: `Ваш полис страхования на автомобиль ${car.car_info}.`,
            });
            ctx.reply(`Полис (policy_id: ${policyID}) для пользователя @${ctx.message.from.username} (user_id: ${userId}) на автомобиль ${car.car_info} (car_id: ${carId}) успешно сохранен в базе и отправлен.`);
          });
    
          uploadStream.on('error', (error) => {
            console.error('Ошибка при загрузке в GridFS:', error.message);
            ctx.reply('Произошла ошибка при загрузке документа.');
          });
    
        } catch (error) {
          console.error("Ошибка при сохранении полиса:", error.message);
          ctx.reply("Произошла ошибка при сохранении полиса. Проверьте логи для получения дополнительной информации.");
        }
    
        return;
      }
    
      // Пересылаем документ администратору
      await ctx.telegram.sendDocument(ADMIN_CHAT_ID, document.file_id, {
        caption: `Документ от пользователя @${ctx.from.username} 🆔: ${ctx.from.id}`,
      });
      ctx.reply("Спасибо за ваш документ!");
    });

    // Send messages to users
    bot.on("channel_post", async (ctx) => {
      const post = ctx.channelPost;
      const postText = post.text.trim();

      // Проверяем, что пост содержит текст
      if (!postText) {
        console.log("Сообщение в канале пустое, ничего не отправляем.");
        return;
      }

      // Регулярное выражение для извлечения ID чата и сообщения
      const regex = /^(\d+)\s+(.+)$/;
      const match = postText.match(regex);

      // Если сообщение не соответствует шаблону, логируем и выходим
      if (!match) {
        ctx.reply("Сообщение не содержит корректный ID чата или текст.");
        return;
      }

      // Извлекаем ID чата и текст сообщения
      const chatId = match[1];
      const message = match[2];

      try {
        // Отправляем сообщение в указанный чат
        await ctx.telegram.sendMessage(chatId, message);
        console.log(`Сообщение отправлено в чат с ID: ${chatId}`);
      } catch (error) {
        console.error(
          `Ошибка при отправке сообщения в чат с ID: ${chatId}`,
          error
        );
      }
    });


    const checkAndUpdateExpiredPolicies = async () => {
      try {
          const allCars = await carsCollection.find({}).toArray();
  
          for (const car of allCars) {
              for (const p of car.policies) {
                  const currentDate = new Date();
                  const expirationDate = new Date(p.date_of_expiration);
                  const isReminderDate = new Date(expirationDate);
                  isReminderDate.setDate(expirationDate.getDate() - 2);
  
                  // Send reminder message for expiring policies
                  if (p.status === 'active' && currentDate.toDateString() === isReminderDate.toDateString()) {
                      await bot.telegram.sendMessage(car.user_id, `Напоминание: Ваш полис страхования на автомобиле ${car.car_info} истечет через 2 дня. Пожалуйста, убедитесь, что он обновлен.`);
                  }
  
                  // Archive expired policies
                  if (p.status === 'active' && expirationDate < currentDate) {
                      await carsCollection.updateOne(
                          { _id: car._id, 'policies.id': p.id },
                          { $set: { 'policies.$.status': 'archived' } }
                      );
  
                      await bot.telegram.sendMessage(car.user_id, `Ваш полис страхования устарел на автомобиле ${car.car_info}. Пожалуйста, обновите его.`);

                      // Activate any pending policies if there are no active policies
                      const hasPendingPolicy = car.policies.some(p => p.status === 'pending');
                      if (hasPendingPolicy) {
                          await carsCollection.updateOne(
                              { _id: car._id, 'policies.status': 'pending' },
                              { $set: { 'policies.$.status': 'active' } }
                          );
          
                          await bot.telegram.sendMessage(car.user_id, `Ваш полис страхования на автомобиле ${car.car_info} был активирован.`);
                      }
                  }
              }
          }
      } catch (error) {
          console.error('Ошибка при проверке и обновлении полисов:', error.message);
      }
    };

    cron.schedule('00 8 * * *', () => {
      console.log('Checking and updating expired policies...');
      checkAndUpdateExpiredPolicies();
    });

    bot.launch();
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB", err);
  });