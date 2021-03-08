const axios = require('axios');
const querystring = require('querystring');
const url = "https://" + process.env.storageAccount + ".table.core.windows.net/daily";
const key = process.env.sasToken;

let messages = {
    marketClosed: (name) => { return `Market is closed, <@${name}>.` },
    last30Minutes: (name) => { return `No more bets in the last 30 minutes of trading, <@${name}>.` },
    predictionReceived: (prediction, interval) => { return `Guess $${prediction} T${interval} received.` },
    predictionNotANumber: (value) => { return `${value} is not a valid input. I need a number.` },
    predictionAlreadySubmitted: () => { return `User already entered a guess in this trading hour.` },
    predictionsFull: () => { return `User already has 3 guesses for the day.` },
    error: () => { return "Something went wrong. Sorry for that." }
}

function getInterval(date) {
    var openDate = date.setHours(14).setMinutes(30).setSeconds(0).setMilliseconds(0);
    var diffMins = Math.round((now - openDate) / 60000);

    if ((diffMins < 0) || (diffMins > 360)) {
        if ((diffMins < 390) && (diffMins > 360)) {
            context.log("No more bets in the last 30 minutes of trading.");
            return 0
        } else {
            context.log("Market is closed.");
            return -1
        }
    } else {
        if (diffMins <= 60) {
            return 6;
        } else if (diffMins <= 120) {
            return 5;
        } else if (diffMins <= 180) {
            return 4;
        } else if (diffMins <= 240) {
            return 3;
        } else if (diffMins <= 300) {
            return 2;
        } else if (diffMins <= 360) {
            return 1;
        }
    }
}

async function getPrediction(dateString, userId) {
    try {
        let res = await axios(`${url}(PartitionKey=${dateString},RowKey='${userId}')${key}`)
        return res.data
    } catch (error) {
        if (error.response.status == 404) {
            return null
        } else {
            context.error(JSON.stringify(error))
            return new Error("Something went wrong")
        }
    }
}

async function addPrediction(dateString, userId, interval, prediction, predictionNumber) {
    try {
        return await axios.post(url + key, {
            PartitionKey: dateString,
            RowKey: userId,
            [`prediction${predictionNumber}`]: prediction,
            [`prediction${predictionNumber}_t`]: interval
        })
    } catch (error) {
        context.error(JSON.stringify(error))
        return new Error("Something went wrong")
    }
}

function getNextPrediction(currentPredictions) {
    if (currentPredictions == null)
        return 1
    if (currentPredictions.prediction2 === 'undefined')
        return 2
    if (currentPredictions.prediction3 === 'undefined')
        return 3
    return 0
}

function getCanSubmitPrediction(interval, nextPrediction, existingPredictions) {
    if (nextPrediction == 0)
        return {
            continue: false,
            message: 'predictionsFull'
        }
    else
        if (existingPredictions[`prediction${nextPrediction - 1}_t`] == interval)
            return {
                continue: false,
                message: 'predictionAlreadySubmitted'
            }
        else return {
            continue: true
        }
}

async function sendSlackMessage(message) {
    try {
        let reply = await axios({
            method: 'post',
            url: "https://slack.com/api/chat.postMessage",
            data: {
                "text": message,
                "channel": process.env.slackWorkspaceChannelId
            },
            headers: {
                "Authorization": process.env.slackWorkspaceBearerToken
            }
        })

        context.log("Message posted successfully, status: " + reply.status);
        context.log("Message body: " + JSON.stringify(reply.data))
    } catch (error) {
        context.error(error)
    }
}

module.exports = async function (context, req) {

    context.log("Request received. Body:");
    context.log(JSON.stringify(querystring.parse(req.body)));
    const reqJSON = querystring.parse(req.body);

    const now = new Date();
    const interval = getInterval(now)
    const prediction = parseFloat(reqJSON.text);
    const id = reqJSON.user_id;
    const dateString = `${now.getFullYear()}${now.getMonth()}${now.getDay()}`

    if (interval == 0) {
        await sendSlackMessage(messages.last30Minutes(reqJSON.user_id))
        return
    }
    if (interval == -1) {
        await sendSlackMessage(messages.marketClosed(reqJSON.user_id))
        return
    }

    if (isNaN(prediction)) {
        context.log("not a number lol")
        await sendSlackMessage(messages.predictionNotANumber(reqJSON.text))
        return;
    }

    try {
        let existingPredictions = await getPrediction(dateString, id)
        let nextPrediction = getNextPrediction(existingPredictions)
        let canSubmitPrediction = getCanSubmitPrediction(interval, nextPrediction, existingPredictions)
        if (canSubmitPrediction.continue == false) {
            await sendSlackMessage(messages[canSubmitPrediction.message])
        } else {
            await addPrediction(dateString, id, interval, prediction, nextPrediction)
            await sendSlackMessage(messages.predictionReceived(prediction, interval))
        }
    }
    catch (error) {
        context.error(error)
        await sendSlackMessage(messages.error())
    }
}