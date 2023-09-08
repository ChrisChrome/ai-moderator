const config = require('./config.json');
const colors = require('colors');
const Discord = require('discord.js');
const {
	REST,
	Routes
} = require('discord.js');
const rest = new REST({
	version: '10'
}).setToken(config.discord_token);
const OpenAI = require("openai");
const client = new Discord.Client({
	intents: ['GuildMessages', "MessageContent", "Guilds", "GuildMembers"],
});
const openai = new OpenAI({ apiKey: config.openai_token });
const dbConn = require('node-json-db').JsonDB;
const dbConfig = require('node-json-db/dist/lib/JsonDBConfig').Config;
const db = new dbConn(new dbConfig("database", true, true, '/'));

var sendLog;
var logMsg = null; // Used to store the log message, so it can be edited instead of sending a new one
var curMsg = ""; // Used to calculate the length of the log message, so it can be edited instead of sending a new one
var logChannel;
client.on('ready', async () => {
	await client.channels.fetch(config.log_channel).then(async (channel) => {
		await channel.send(`\`\`\`ansi\n${curMsg}\`\`\``).then((msg) => {
			logMsg = msg;
		});
		sendLog = async (message) => {
			let timestamp = new Date()
			message = `[${timestamp.toLocaleString()}] ${message}`;
			if (curMsg.length + message.length <= 2000) {
				curMsg = `${curMsg}\n${message}`;
				await logMsg.edit(`\`\`\`ansi\n${curMsg}\`\`\``);
			} else {
				curMsg = message;
				await channel.send(`\`\`\`ansi\n${message}\`\`\``).then((msg) => {
					logMsg = msg;
				});
			}
			console.log(message);
		};

		console.log(`${colors.cyan("[INFO]")} Loading Commands...`)
		const commands = require('./commands.json');
		await (async () => {
			try {
				console.log(`${colors.cyan("[INFO]")} Registering Commands...`)
				let start = Date.now()
				//Globally
				console.log(`${colors.cyan("[INFO]")} Registering Global Commands...`);
				await rest.put(
					Routes.applicationCommands(client.user.id), {
					body: commands
				});
				console.log(`${colors.cyan("[INFO]")} Successfully registered commands. Took ${colors.green((Date.now() - start) / 1000)} seconds.`);
			} catch (error) {
				console.error(error);
			}
		})();

		sendLog(`${colors.cyan("[INFO]")} Logged in as ${client.user.displayName}!`);

		client.user.setPresence({
			activities: [{
				name: `you`,
				type: "WATCHING"
			}],
			status: "online"
		});

	});


});

client.on('interactionCreate', async (interaction) => {
	if (!interaction.isCommand()) return;
	switch (interaction.commandName) {
		case "config":
			switch (interaction.options.getSubcommand()) {
				case "logs":
					if (!interaction.member.permissions.has("MANAGE_GUILD")) {
						await interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true });
						return;
					}
					let channel = interaction.options.getChannel("channel");
					if (!channel) {
						await interaction.reply({ content: "Please specify a channel.", ephemeral: true });
						return;
					}
					db.push(`/guilds/${interaction.guildId}/log_channel`, channel.id, true);
					await interaction.reply({ content: `Set log channel to ${channel}.`, ephemeral: true });
					break;
			};
			break;
	}
});
client.on('messageCreate', async (message) => {
	if (message.author.bot) return;
	if (message.channel.type === "DM") return;
	if (!message.content) return; // If the message is empty, don't do anything
	let results = await openai.moderations.create({ input: message.content, model: "text-moderation-latest" });

	if (!results.results[0].flagged) return; // No need to do anything if the message isn't flagged
	let categories = results.results[0].categories;
	// Check all categories against the config and decide what to do
	// Use a for loop to iterate over the categories
	// whitelist is an array of channel and discord category IDs to ignore for that category
	/* // Old code, kept for reference
	for (const [category, data] of Object.entries(categories)) {
		if (!data) continue; // If the category isn't flagged, skip it	
		if (!config.categories[category].enabled) continue; // If the category is disabled, skip it
		if (config.categories[category].whitelist.includes(message.channel.id)) continue; // If the channel is whitelisted, skip it
		if (data) {
			if (config.categories[category].punishment === "delete") {
				await message.delete();
				await sendLog(`${colors.cyan("[INFO]")} Deleted message from ${message.author.tag} in ${message.channel.name} because it was flagged for ${category} content.`);
			} else if (config.categories[category].punishment === "ban") {
				await message.member.ban({ reason: `Message flagged for ${category} content.` });
				await sendLog(`${colors.cyan("[INFO]")} Banned ${message.author.tag} because their message was flagged for ${category} content.`);
			} else if (config.categories[category].punishment === "kick") {
				await message.member.kick({ reason: `Message flagged for ${category} content.` });
				await sendLog(`${colors.cyan("[INFO]")} Kicked ${message.author.tag} because their message was flagged for ${category} content.`);
			}
		}
	}*/
	// Get all the categories that are flagged, and get their appropriate punishments, then do the punishments
	let flaggedCategories = {};
	for (const [category, data] of Object.entries(categories)) {
		if (!data) continue; // If the category isn't flagged, skip it
		if (!config.categories[category].enabled) continue; // If the category is disabled, skip it
		if (config.categories[category].whitelist.includes(message.channel.id)) continue; // If the channel is whitelisted, skip it
		if (config.categories[category].whitelist.includes(message.channel.parentId)) continue; // If the category is whitelisted, skip it
		flaggedCategories[category] = config.categories[category].punishment;
	}
	await db.getData(`/guilds/${message.guildId}/log_channel`).then((channelId) => {
		logChannel = client.channels.cache.get(channelId);
	});
	// Get a list of punishments, one per type
	let punishments = Object.values(flaggedCategories);
	if (punishments.includes("ban")) {
		message.delete();
		message.member.ban({ reason: `Message flagged for ${Object.keys(flaggedCategories).join(", ")} content.` });
		if (logChannel) {
			logChannel.send({
				embeds: [{
					title: "User Banned",
					description: `**User:** ${message.author}\n**Channel:** ${message.channel}\n**Reason:** Message flagged for ${Object.keys(flaggedCategories).join(", ")} content.`,
					color: 0xff0000,
					timestamp: new Date(),
					fields: [
						{
							name: "Message",
							value: message.content.substring(0, 1024)
						}
					]
				}]
			})
		}
	} else if (punishments.includes("kick")) {
		message.delete();
		message.member.kick({ reason: `Message flagged for ${Object.keys(flaggedCategories).join(", ")} content.` });
		if (logChannel) {
			logChannel.send({
				embeds: [{
					title: "User Kicked",
					description: `**User:** ${message.author}\n**Channel:** ${message.channel}\n**Reason:** Message flagged for ${Object.keys(flaggedCategories).join(", ")} content.`,
					color: 0xff0000,
					timestamp: new Date(),
					fields: [
						{
							name: "Message",
							// Truncate the message to 1024 characters, the max for an embed field
							value: message.content.substring(0, 1024)
						}
					]
				}]
			})
		}
	} else if (punishments.includes("delete")) {
		message.delete({ reason: `Message flagged for ${Object.keys(flaggedCategories).join(", ")} content.` });
		if (logChannel) {
			logChannel.send({
				embeds: [{
					title: "Message Deleted",
					description: `**User:** ${message.author}\n**Channel:** ${message.channel}\n**Reason:** Message flagged for ${Object.keys(flaggedCategories).join(", ")} content.`,
					color: 0xff0000,
					timestamp: new Date(),
					fields: [
						{
							name: "Message",
							value: message.content.substring(0, 1024)
						}
					]
				}]
			})
		}
	}

});

// Catch all errors
process.on('uncaughtException', async (err) => {
	await sendLog(`${colors.red("[ERROR]")} Uncaught Exception: ${err}`);
});

process.on('unhandledRejection', async (err) => {
	await sendLog(`${colors.red("[ERROR]")} Unhandled Rejection: ${err}`);
});



// Handle SIGINT gracefully
process.on('SIGINT', async () => {
	await console.log(`${colors.cyan("[INFO]")} Stop received, exiting...`);
	await client.user.setPresence({
		status: "invisible",
		activities: []
	});
	await client.destroy();
	await console.log(`${colors.cyan("[INFO]")} Goodbye!`);
	process.exit(0);
});


console.log(`${colors.cyan("[INFO]")} Starting...`)
// Start timer to see how long startup takes
const initTime = Date.now()
// Login to Discord
client.login(config.discord_token);