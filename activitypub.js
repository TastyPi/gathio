const domain = require('./config/domain.js').domain;
const contactEmail = require('./config/domain.js').email;
const siteName = require('./config/domain.js').sitename;
const isFederated = require('./config/domain.js').isFederated;
const request = require('request');
const addToLog = require('./helpers.js').addToLog;
const crypto = require('crypto');
// This alphabet (used to generate all event, group, etc. IDs) is missing '-'
// because ActivityPub doesn't like it in IDs
const generate = require('nanoid/generate');
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
var moment = require('moment-timezone');
const mongoose = require('mongoose');
const Event = mongoose.model('Event');
const EventGroup = mongoose.model('EventGroup');
var sanitizeHtml = require('sanitize-html');

function createActivityPubActor(eventID, domain, pubkey, description, name, location, imageFilename, startUTC, endUTC, timezone) {
  let actor = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1'
    ],

    'id': `https://${domain}/${eventID}`,
    'type': 'Person',
    'preferredUsername': `${eventID}`,
    'inbox': `https://${domain}/activitypub/inbox`,
    'outbox': `https://${domain}/${eventID}/outbox`,
    'followers': `https://${domain}/${eventID}/followers`,
    'summary': `<p>${description}</p>`,
    'name': name,
    'featured': `https://${domain}/${eventID}/featured`,

    'publicKey': {
      'id': `https://${domain}/${eventID}#main-key`,
      'owner': `https://${domain}/${eventID}`,
      'publicKeyPem': pubkey
    }
  };
  if (location) {
    actor.summary += `<p>Location: ${location}.</p>`
  }
  let displayDate;
  if (startUTC && timezone) {
    displayDate = moment.tz(startUTC, timezone).format('D MMMM YYYY h:mm a');
    actor.summary += `<p>Starting ${displayDate} ${timezone}.</p>`;
  }
  if (imageFilename) {
    actor.icon = {
      'type': 'Image',
      'mediaType': 'image/jpg',
      'url': `https://${domain}/events/${imageFilename}`,
    };
  }
  return JSON.stringify(actor);
}

function createActivityPubEvent(name, startUTC, endUTC, timezone, description, location) {
  const guid = crypto.randomBytes(16).toString('hex');
  let eventObject = {
    "@context": "https://www.w3.org/ns/activitystreams",
    'id': `https://${domain}/${guid}`,
    "name": name,
    "type": "Event",
    "startTime": moment.tz(startUTC, timezone).format(),
    "endTime": moment.tz(endUTC, timezone).format(),
    "content": description,
    "location": location
  }
  return JSON.stringify(eventObject);
}

function createFeaturedPost(eventID, name, startUTC, endUTC, timezone, description, location) {
  const featured = {
    "@context": "https://www.w3.org/ns/activitystreams",
    "id": `https://${domain}/${eventID}/m/featuredPost`,
    "type": "Note",
    "name": "Test",
    'cc': 'https://www.w3.org/ns/activitystreams#Public',
    "content": `<p>This is an event that was posted on <a href="https://${domain}">${siteName}</a>. If you follow this account, you'll see updates in your timeline about the event. If your software supports polls, you should get a poll in your DMs asking if you want to RSVP. You can reply and RSVP right from there. If your software has an event calendar built in, you should get an event in your inbox that you can RSVP to like you respond to any event.</p><p>For more information on how to interact with this, <a href="https://github.com/lowercasename/gathio/wiki/Fediverse-Instructions">check out this link</a>.</p>`,
    'attributedTo': `https://${domain}/${eventID}`,
  }
  return featured;
}

function updateActivityPubEvent(oldEvent, name, startUTC, endUTC, timezone, description, location) {
  // we want to persist the old ID no matter what happens to the Event itself
  const id = oldEvent.id;
  let eventObject = {
    "@context": "https://www.w3.org/ns/activitystreams",
    'id': id,
    "name": name,
    "type": "Event",
    "startTime": moment.tz(startUTC, timezone).format(),
    "endTime": moment.tz(endUTC, timezone).format(),
    "content": description,
    "location": location
  }
  return JSON.stringify(eventObject);
}


function updateActivityPubActor(actor, description, name, location, imageFilename, startUTC, endUTC, timezone) {
  if (!actor) return;
  actor.summary = `<p>${description}</p>`;
  actor.name = name;
  if (location) {
    actor.summary += `<p>Location: ${location}.</p>`
  }
  let displayDate;
  if (startUTC && timezone) {
    displayDate = moment.tz(startUTC, timezone).format('D MMMM YYYY h:mm a');
    actor.summary += `<p>Starting ${displayDate} ${timezone}.</p>`;
  }
  if (imageFilename) {
    actor.icon = {
      'type': 'Image',
      'mediaType': 'image/jpg',
      'url': `https://${domain}/events/${imageFilename}`,
    };
  }
  return JSON.stringify(actor);
}

function signAndSend(message, eventID, targetDomain, inbox, callback) {
  if (!isFederated) return;
  let inboxFragment = inbox.replace('https://'+targetDomain,'');
  // get the private key
	Event.findOne({
		id: eventID
		})
		.then((event) => {
      if (event) { 
        const privateKey = event.privateKey;
        const signer = crypto.createSign('sha256');
        let d = new Date();
        let stringToSign = `(request-target): post ${inboxFragment}\nhost: ${targetDomain}\ndate: ${d.toUTCString()}`;
        signer.update(stringToSign);
        signer.end();
        const signature = signer.sign(privateKey);
        const signature_b64 = signature.toString('base64');
        const header = `keyId="https://${domain}/${eventID}",headers="(request-target) host date",signature="${signature_b64}"`;
        request({
          url: inbox,
          headers: {
            'Host': targetDomain,
            'Date': d.toUTCString(),
            'Signature': header
          },
          method: 'POST',
          json: true,
          body: message
        }, function (error, response){
          if (error) {
            callback(error, null, 500);
          }
          else {
            // Add the message to the database
            const messageID = message.id;
            const newMessage = {
              id: message.id,
              content: JSON.stringify(message)
            };
            Event.findOne({
              id: eventID,
              }, function(err,event) {
              if (!event) return;
              event.activityPubMessages.push(newMessage);
              // also add the message's object if it has one
              if (message.object && message.object.id) {
                event.activityPubMessages.push({
                  id: message.object.id,
                  content: JSON.stringify(message.object)
                });
              }
              event.save()
              .then(() => {
                addToLog("addActivityPubMessage", "success", "ActivityPubMessage added to event " + eventID);
                callback(null, message.id, 200);
              })
              .catch((err) => { addToLog("addActivityPubMessage", "error", "Attempt to add ActivityPubMessage to event " + eventID + " failed with error: " + err);
                callback(err, null, 500);
              });
            })
          }
        });
      }
      else {
        callback(`No record found for ${eventID}.`, null, 404);
      }
    });
}

// this function sends something to the timeline of every follower in the followers array
// it's also an unlisted public message, meaning non-followers can see the message if they look at
// the profile but it doesn't spam federated timelines
function broadcastCreateMessage(apObject, followers, eventID) {
  if (!isFederated) return;
  let guidCreate = crypto.randomBytes(16).toString('hex');
  Event.findOne({
    id: eventID,
    }, function(err, event) {
    if (event) {
      // iterate over followers
      for (const follower of followers) {
        let actorId = follower.actorId;
        let myURL = new URL(actorId);
        let targetDomain = myURL.hostname;
        // get the inbox
        const followerFound = event.followers.find(el => el.actorId === actorId);
        if (followerFound) {
          const actorJson = JSON.parse(follower.actorJson);
          const inbox = actorJson.inbox;
          const createMessage = {
            '@context': 'https://www.w3.org/ns/activitystreams',
            'id': `https://${domain}/${eventID}/m/${guidCreate}`,
            'type': 'Create',
            'actor': `https://${domain}/${eventID}`,
            'to': [actorId],
            'cc': 'https://www.w3.org/ns/activitystreams#Public',
            'object': apObject
          };
          signAndSend(createMessage, eventID, targetDomain, inbox, function(err, resp, status) {
            if (err) {
              console.log(`Didn't send to ${actorId}, status ${status} with error ${err}`);
            }
            else {
              console.log('sent to', actorId);
            }
          });
        }
        else {
          console.log(`No follower found with the id ${actorId}`);
        }
      } // end followers
    } // end if event
    else {
      console.log(`No event found with the id ${eventID}`);
    }
  });
}


// sends an Announce for the apObject
function broadcastAnnounceMessage(apObject, followers, eventID) {
  if (!isFederated) return;
  let guidUpdate = crypto.randomBytes(16).toString('hex');
  Event.findOne({
    id: eventID,
    }, function(err, event) {
    if (event) {
      // iterate over followers
      for (const follower of followers) {
        let actorId = follower.actorId;
        let myURL = new URL(actorId);
        let targetDomain = myURL.hostname;
        // get the inbox
        const followerFound = event.followers.find(el => el.actorId === actorId);
        if (followerFound) {
          const actorJson = JSON.parse(follower.actorJson);
          const inbox = actorJson.inbox;
          const announceMessage = {
            '@context': 'https://www.w3.org/ns/activitystreams',
            'id': `https://${domain}/${eventID}/m/${guidUpdate}`,
            'cc': 'https://www.w3.org/ns/activitystreams#Public',
            'type': 'Announce',
            'actor': `https://${domain}/${eventID}`,
            'object': apObject,
            'to': actorId
          };
          signAndSend(announceMessage, eventID, targetDomain, inbox, function(err, resp, status) {
            if (err) {
              console.log(`Didn't send to ${actorId}, status ${status} with error ${err}`);
            }
            else {
              console.log('sent to', actorId);
            }
          });
        }
        else {
          console.log(`No follower found with the id ${actorId}`);
        }
      } // end followers
    } // end if event
    else {
      console.log(`No event found with the id ${eventID}`);
    }
  });
}

// sends an Update for the apObject
function broadcastUpdateMessage(apObject, followers, eventID) {
  if (!isFederated) return;
  let guidUpdate = crypto.randomBytes(16).toString('hex');
  // iterate over followers
  Event.findOne({
    id: eventID,
    }, function(err, event) {
    if (event) {
      for (const follower of followers) {
        let actorId = follower.actorId;
        let myURL = new URL(actorId);
        let targetDomain = myURL.hostname;
        // get the inbox
        const followerFound = event.followers.find(el => el.actorId === actorId);
        if (followerFound) {
          const actorJson = JSON.parse(follower.actorJson);
          const inbox = actorJson.inbox;
          const createMessage = {
            '@context': 'https://www.w3.org/ns/activitystreams',
            'id': `https://${domain}/${eventID}/m/${guidUpdate}`,
            'type': 'Update',
            'actor': `https://${domain}/${eventID}`,
            'object': apObject
          };
          signAndSend(createMessage, eventID, targetDomain, inbox, function(err, resp, status) {
            if (err) {
              console.log(`Didn't send to ${actorId}, status ${status} with error ${err}`);
            }
            else {
              console.log('sent to', actorId);
            }
          });
        }
        else {
          console.log(`No follower found with the id ${actorId}`);
        }
      } // end followers
    }
    else {
      console.log(`No event found with the id ${eventID}`);
    }
  });
}

function broadcastDeleteMessage(apObject, followers, eventID, callback) {
  if (!isFederated) return;
  callback = callback || function() {};
  // we need to build an array of promises for each message we're sending, run Promise.all(), and then that will resolve when every message has been sent (or failed)
  // per spec, each promise will execute *as it is built*, which is fine, we just need the guarantee that they are all done
  let promises = [];

  let guidUpdate = crypto.randomBytes(16).toString('hex');
  // iterate over followers
  for (const follower of followers) {
    promises.push(new Promise((resolve, reject) => {
      let actorId = follower.actorId;
      let myURL = new URL(actorId);
      let targetDomain = myURL.hostname;
      // get the inbox
      Event.findOne({
        id: eventID,
        }, function(err, event) {
        if (event) {
          const follower = event.followers.find(el => el.actorId === actorId);
          if (follower) {
            const actorJson = JSON.parse(follower.actorJson);
            const inbox = actorJson.inbox;
            const createMessage = {
              '@context': 'https://www.w3.org/ns/activitystreams',
              'id': `https://${domain}/${eventID}/m/${guidUpdate}`,
              'type': 'Delete',
              'actor': `https://${domain}/${eventID}`,
              'object': apObject
            };
            signAndSend(createMessage, eventID, targetDomain, inbox, function(err, resp, status) {
              if (err) {
                console.log(`Didn't send to ${actorId}, status ${status} with error ${err}`);
                reject(`Didn't send to ${actorId}, status ${status} with error ${err}`);
              }
              else {
                console.log('sent to', actorId);
                resolve('sent to', actorId);
              }
            });
          }
          else {
            console.log(`No follower found with the id ${actorId}`, null, 404);
            reject(`No follower found with the id ${actorId}`, null, 404);
          }
        }
        else {
          console.log(`No event found with the id ${eventID}`, null, 404);
          reject(`No event found with the id ${eventID}`, null, 404);
        }
      }); // end event
    }));
  } // end followers

  Promise.all(promises.map(p => p.catch(e => e))).then(statuses => {
    callback(statuses);
  });
}

// this sends a message "to:" an individual fediverse user
function sendDirectMessage(apObject, actorId, eventID, callback) {
  if (!isFederated) return;
  callback = callback || function() {};
  const guidCreate = crypto.randomBytes(16).toString('hex');
  const guidObject = crypto.randomBytes(16).toString('hex');
  let d = new Date();

  apObject.published = d.toISOString();
  apObject.attributedTo = `https://${domain}/${eventID}`;
  apObject.to = actorId;
  apObject.id = `https://${domain}/${eventID}/m/${guidObject}`;
  apObject.content = unescape(apObject.content)

  let createMessage = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    'id': `https://${domain}/${eventID}/m/${guidCreate}`,
    'type': 'Create',
    'actor': `https://${domain}/${eventID}`,
    'to': [actorId],
    'object': apObject
  };

  let myURL = new URL(actorId);
  let targetDomain = myURL.hostname;
  // get the inbox
  Event.findOne({
    id: eventID,
    }, function(err, event) {
    if (event) {
      const follower = event.followers.find(el => el.actorId === actorId);
      if (follower) {
        const actorJson = JSON.parse(follower.actorJson);
        const inbox = actorJson.inbox;
        signAndSend(createMessage, eventID, targetDomain, inbox, callback);
      }
      else {
        callback(`No follower found with the id ${actorId}`, null, 404);
      }
    }
    else {
      callback(`No event found with the id ${eventID}`, null, 404);
    }
  });
}

function sendAcceptMessage(thebody, eventID, targetDomain, callback) {
  if (!isFederated) return;
  callback = callback || function() {};
  const guid = crypto.randomBytes(16).toString('hex');
  const actorId = thebody.actor;
  let message = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    'id': `https://${domain}/${guid}`,
    'type': 'Accept',
    'actor': `https://${domain}/${eventID}`,
    'object': thebody,
  };
  // get the inbox
  Event.findOne({
    id: eventID,
    }, function(err, event) {
    if (event) {
      const follower = event.followers.find(el => el.actorId === actorId);
      if (follower) {
        const actorJson = JSON.parse(follower.actorJson);
        const inbox = actorJson.inbox;
        signAndSend(message, eventID, targetDomain, inbox, callback);
      }
    }
    else {
      callback(`Could not find event ${eventID}`, null, 404);
    }
  });
}

function _handleFollow(req, res) {
  const myURL = new URL(req.body.actor);
  let targetDomain = myURL.hostname;
  let eventID = req.body.object.replace(`https://${domain}/`,'');
  // Add the user to the DB of accounts that follow the account
  // get the follower's username
  request({
    url: req.body.actor,
    headers: {
      'Accept': 'application/activity+json',
      'Content-Type': 'application/activity+json'
    }}, function (error, response, body) {
      body = JSON.parse(body)
      const name = body.preferredUsername || body.name || body.attributedTo;
      const newFollower = {
        actorId: req.body.actor,
        followId: req.body.id,
        name: name,
        actorJson: JSON.stringify(body)
      };
      Event.findOne({
        id: eventID,
        }, function(err,event) {
        // if this account is NOT already in our followers list, add it
        if (event && !event.followers.map(el => el.actorId).includes(req.body.actor)) {
          event.followers.push(newFollower);
          event.save()
          .then(() => {
            addToLog("addEventFollower", "success", "Follower added to event " + eventID);
            // Accept the follow request
            sendAcceptMessage(req.body, eventID, targetDomain, function(err, resp, status) {
              if (err) {
                console.log(`Didn't send Accept to ${req.body.actor}, status ${status} with error ${err}`);
              }
              else {
                console.log('sent Accept to', req.body.actor);
                // ALSO send an ActivityPub Event activity since this person is "interested" in the event, as indicated by the Follow
                const jsonEventObject = JSON.parse(event.activityPubEvent);
                // send direct message to user
                sendDirectMessage(jsonEventObject, newFollower.actorId, event.id);

                // if users can self-RSVP, send a Question to the new follower
                if (event.usersCanAttend) {
                  const jsonObject = {
                    "@context": "https://www.w3.org/ns/activitystreams",
                    "name": `RSVP to ${event.name}`,
                    "type": "Question",
                     "content": `<span class=\"h-card\"><a href="${req.body.actor}" class="u-url mention">@<span>${name}</span></a></span> Will you attend ${event.name}? (If you reply "Yes", you'll be listed as an attendee on the event page.)`,
                     "oneOf": [
                       {"type":"Note","name": "Yes"},
                     ],
                    "endTime":event.start.toISOString(),
                    "tag":[{"type":"Mention","href":req.body.actor,"name":name}]
                  }
                  // send direct message to user
                  sendDirectMessage(jsonObject, req.body.actor, eventID, function (error, response, statuscode) {
                    if (error) {
                      console.log('Error sending direct message:', error);
                      return res.status(statuscode).json(error);
                    }
                    else {
                      return res.status(statuscode).json({messageid: response});
                    }
                  });
                }
              }
            });
          })
          .catch((err) => {
            addToLog("addEventFollower", "error", "Attempt to add follower to event " + eventID + " failed with error: " + err); 
            return res.status(500).send('Database error, please try again :(');
          });
        }
        else {
          // this person is already a follower so just say "ok"
          return res.status(200);
        }
      })
    }) //end request
}

function _handleUndoFollow(req, res) {
  // get the record of all followers for this account
  const eventID = req.body.object.object.replace(`https://${domain}/`,'');
  Event.findOne({
    id: eventID,
    }, function(err,event) {
      if (!event) return;
      // check to see if the Follow object's id matches the id we have on record
      // is this even someone who follows us
      const indexOfFollower = event.followers.findIndex(el => el.actorId === req.body.object.actor);
      if (indexOfFollower !== -1) {
        // does the id we have match the id we are being given
        if (event.followers[indexOfFollower].followId === req.body.object.id) {
          // we have a match and can trust the Undo! remove this person from the followers list
          event.followers.splice(indexOfFollower, 1);
          event.save()
          .then(() => {
            addToLog("removeEventFollower", "success", "Follower removed from event " + eventID);
            return res.sendStatus(200);
          })
          .catch((err) => { 
            addToLog("removeEventFollower", "error", "Attempt to remove follower from event " + eventID + " failed with error: " + err); 
            return res.send('Database error, please try again :('); 
          });
        }
      }
  });
}

function _handleAcceptEvent(req, res) {
  let {name, attributedTo, inReplyTo, to, actor} = req.body;
  if (Array.isArray(to)) {
    to = to[0];
  }
  const eventID = to.replace(`https://${domain}/`,'');
  Event.findOne({
    id: eventID,
    }, function(err,event) {
      if (!event) return;
      // does the id we got match the id of a thing we sent out
      const message = event.activityPubMessages.find(el => el.id === req.body.object);
      if (message) {
        // it's a match
        request({
          url: actor,
          headers: {
            'Accept': 'application/activity+json',
            'Content-Type': 'application/activity+json'
          }}, function (error, response, body) {
            body = JSON.parse(body)
            // if this account is NOT already in our attendees list, add it
            if (!event.attendees.map(el => el.id).includes(actor)) {
              const attendeeName = body.preferredUsername || body.name || actor;
              const newAttendee = {
                name: attendeeName,
                status: 'attending',
                id: actor
              };
              event.attendees.push(newAttendee);
              event.save()
              .then((fullEvent) => {
                addToLog("addEventAttendee", "success", "Attendee added to event " + req.params.eventID);
                // get the new attendee with its hidden id from the full event
                let fullAttendee = fullEvent.attendees.find(el => el.id === actor);
                // send a "click here to remove yourself" link back to the user as a DM
                const jsonObject = {
                  "@context": "https://www.w3.org/ns/activitystreams",
                  "name": `RSVP to ${event.name}`,
                  "type": "Note",
                  "content": `<span class=\"h-card\"><a href="${newAttendee.id}" class="u-url mention">@<span>${newAttendee.name}</span></a></span> Thanks for RSVPing! You can remove yourself from the RSVP list by clicking here: <a href="https://${domain}/oneclickunattendevent/${event.id}/${fullAttendee._id}">https://${domain}/oneclickunattendevent/${event.id}/${fullAttendee._id}</a>`,
                  "tag":[{"type":"Mention","href":newAttendee.id,"name":newAttendee.name}]
                }
                // send direct message to user
                sendDirectMessage(jsonObject, newAttendee.id, event.id);
                return res.sendStatus(200);
              })
              .catch((err) => { 
                addToLog("addEventAttendee", "error", "Attempt to add attendee to event " + req.params.eventID + " failed with error: " + err);
                return res.status(500).send('Database error, please try again :(');
              });
            }
            else {
              // it's a duplicate and this person is already rsvped so just say OK
              return res.status(200).send("Attendee is already registered.");
            }
        });
      }
    });
}

function _handleUndoAcceptEvent(req, res) {
  let {name, attributedTo, inReplyTo, to, actor} = req.body;
  if (Array.isArray(to)) {
    to = to[0];
  }
  const eventID = to.replace(`https://${domain}/`,'');
  Event.findOne({
    id: eventID,
    }, function(err,event) {
    if (!event) return;
    // does the id we got match the id of a thing we sent out
    const message = event.activityPubMessages.find(el => el.id === req.body.object.object);
    if (message) {
      // it's a match
      Event.update(
          { id: eventID },
          { $pull: { attendees: { id: actor } } }
      )
      .then(response => {
        addToLog("oneClickUnattend", "success", "Attendee removed via one click unattend " + req.params.eventID);
      });
    }
  });
}

function _handleCreateNote(req, res) {
  // figure out what this is in reply to -- it should be addressed specifically to us
  let {name, attributedTo, inReplyTo, to} = req.body.object;
  // if it's an array just grab the first element, since a poll should only broadcast back to the pollster
  if (Array.isArray(to)) {
    to = to[0];
  }
  const eventID = to.replace(`https://${domain}/`,'');
  // make sure this person is actually a follower
  Event.findOne({
    id: eventID,
    }, function(err,event) {
      if (!event) return;
      // is this even someone who follows us
      const indexOfFollower = event.followers.findIndex(el => el.actorId === req.body.object.attributedTo);
      if (indexOfFollower !== -1) {
        // compare the inReplyTo to its stored message, if it exists and it's going to the right follower then this is a valid reply
        const message = event.activityPubMessages.find(el => {
          const content = JSON.parse(el.content);
          return inReplyTo === (content.object && content.object.id);
        });
        if (message) {
          const content = JSON.parse(message.content);
          // check if the message we sent out was sent to the actor this incoming message is attributedTo
          if (content.to[0] === attributedTo) {
            // it's a match, this is a valid poll response, add RSVP to database
            // fetch the profile information of the user
            request({
              url: attributedTo,
              headers: {
                'Accept': 'application/activity+json',
                'Content-Type': 'application/activity+json'
              }}, function (error, response, body) {
                body = JSON.parse(body)
                // if this account is NOT already in our attendees list, add it
                if (!event.attendees.map(el => el.id).includes(attributedTo)) {
                  const attendeeName = body.preferredUsername || body.name || attributedTo;
                  const newAttendee = {
                    name: attendeeName,
                    status: 'attending',
                    id: attributedTo
                  };
                  event.attendees.push(newAttendee);
                  event.save()
                  .then((fullEvent) => {
                    addToLog("addEventAttendee", "success", "Attendee added to event " + req.params.eventID);
                    // get the new attendee with its hidden id from the full event
                    let fullAttendee = fullEvent.attendees.find(el => el.id === attributedTo);
                    // send a "click here to remove yourself" link back to the user as a DM
                    const jsonObject = {
                      "@context": "https://www.w3.org/ns/activitystreams",
                      "name": `RSVP to ${event.name}`,
                      "type": "Note",
                      "content": `<span class=\"h-card\"><a href="${newAttendee.id}" class="u-url mention">@<span>${newAttendee.name}</span></a></span> Thanks for RSVPing! You can remove yourself from the RSVP list by clicking here: <a href="https://${domain}/oneclickunattendevent/${event.id}/${fullAttendee._id}">https://${domain}/oneclickunattendevent/${event.id}/${fullAttendee._id}</a>`,
                      "tag":[{"type":"Mention","href":newAttendee.id,"name":newAttendee.name}]
                    }
                    // send direct message to user
                    sendDirectMessage(jsonObject, newAttendee.id, event.id);
                    return res.sendStatus(200);
                  })
                  .catch((err) => {
                    addToLog("addEventAttendee", "error", "Attempt to add attendee to event " + req.params.eventID + " failed with error: " + err);
                    return res.status(500).send('Database error, please try again :(');
                  });
                }
                else {
                  // it's a duplicate and this person is already rsvped so just say OK
                  return res.status(200).send("Attendee is already registered.");
                }
            });
          }
        }
      }
  });
}

function _handleDelete(req, res) {
  const deleteObjectId = req.body.object.id;
  // find all events with comments from the author
  Event.find({
    "comments.actorId":req.body.actor
    }, function(err,events) {
    if (!events) {
      return res.sendStatus(404);
    }

    // find the event with THIS comment from the author
    let eventWithComment = events.find(event => {
      let comments = event.comments;
      return comments.find(comment => {
        if (!comment.activityJson) {
          return false;
        }
        return JSON.parse(comment.activityJson).object.id === req.body.object.id;
      })
    });

    if (!eventWithComment) {
      return res.sendStatus(404);
    }

    // delete the comment
    // find the index of the comment, it should have an activityJson field because from an AP server you can only delete an AP-originated comment (and of course it needs to be yours)
    let indexOfComment = eventWithComment.comments.findIndex(comment => {
      return comment.activityJson && JSON.parse(comment.activityJson).object.id === req.body.object.id;
    });
    eventWithComment.comments.splice(indexOfComment, 1);
    eventWithComment.save()
    .then(() => {
      addToLog("deleteComment", "success", "Comment deleted from event " + eventWithComment.id);
      return res.sendStatus(200);
    })
    .catch((err) => {
      addToLog("deleteComment", "error", "Attempt to delete comment " + req.body.object.id + "from event " + eventWithComment.id + " failed with error: " + err);
      return res.sendStatus(500); 
    });
  });
}

function _handleCreateNoteComment(req, res) {
  // figure out what this is in reply to -- it should be addressed specifically to us
  let {attributedTo, inReplyTo, to, cc} = req.body.object;
  // normalize cc into an array
  if (typeof cc === 'string') {
    cc = [cc];
  }
  // normalize to into an array
  if (typeof to === 'string') {
    to = [to];
  }
  
  // if this is a public message (in the to or cc fields)
  if (to.includes('https://www.w3.org/ns/activitystreams#Public') || (Array.isArray(cc) && cc.includes('https://www.w3.org/ns/activitystreams#Public'))) {
    // figure out which event(s) of ours it was addressing
    let ourEvents = cc.filter(el => el.includes(`https://${domain}/`))
                  .map(el => el.replace(`https://${domain}/`,''));
    // comments should only be on one event. if more than one, ignore (spam, probably) 
    if (ourEvents.length === 1) {
      let eventID = ourEvents[0];
      // add comment
      let commentID = generate(alphabet, 21);
      // get the actor for the commenter
      request({
        url: req.body.actor,
        headers: {
          'Accept': 'application/activity+json',
          'Content-Type': 'application/activity+json'
        }}, function (error, response, actor) {
        if (!error) {
          const parsedActor = JSON.parse(actor);
          const name = parsedActor.preferredUsername || parsedActor.name || req.body.actor;
          const newComment = {
            id: commentID,
            actorId: req.body.actor,
            activityId: req.body.object.id,
            author: name,
            content: sanitizeHtml(req.body.object.content, {allowedTags: [], allowedAttributes: {}}).replace('@'+eventID,''),
            timestamp: moment(),
            activityJson: JSON.stringify(req.body),
            actorJson: actor
          };

          Event.findOne({
            id: eventID,
            }, function(err,event) {
            if (!event) {
              return res.sendStatus(404);
            }
            if (!event.usersCanComment) {
              return res.sendStatus(200);
            }
            event.comments.push(newComment);
            event.save()
            .then(() => {
              addToLog("addEventComment", "success", "Comment added to event " + eventID);
              const guidObject = crypto.randomBytes(16).toString('hex');
              const jsonObject = req.body.object;
              jsonObject.attributedTo = newComment.actorId;
              broadcastAnnounceMessage(jsonObject, event.followers, eventID)
              return res.sendStatus(200);
            })
            .catch((err) => {
              addToLog("addEventComment", "error", "Attempt to add comment to event " + eventID + " failed with error: " + err);
              res.status(500).send('Database error, please try again :(' + err);
            });
          });
        }
      });
    } // end ourevent
  } // end public message
}

function processInbox(req, res) {
  if (!isFederated) return res.sendStatus(404);
  try {
    // if a Follow activity hits the inbox
    if (typeof req.body.object === 'string' && req.body.type === 'Follow') {
      _handleFollow(req, res);
    }
    // if an Undo activity with a Follow object hits the inbox
    if (req.body && req.body.type === 'Undo' && req.body.object && req.body.object.type === 'Follow') {
      _handleUndoFollow(req, res);
    }
    // if an Accept activity with the id of the Event we sent out hits the inbox, it is an affirmative RSVP
    if (req.body && req.body.type === 'Accept' && req.body.object && typeof req.body.object === 'string') {
      _handleAcceptEvent(req, res);
    }
    // if an Undo activity containing an Accept containing the id of the Event we sent out hits the inbox, it is an undo RSVP
    if (req.body && req.body.type === 'Undo' && req.body.object && req.body.object.object && typeof req.body.object.object === 'string' && req.body.object.type === 'Accept') {
      _handleUndoAcceptEvent(req, res);
    }
    // if a Create activity with a Note object hits the inbox, and it's a reply, it might be a vote in a poll
    if (req.body && req.body.type === 'Create' && req.body.object && req.body.object.type === 'Note' && req.body.object.inReplyTo && req.body.object.to) {
      _handleCreateNote(req, res);
    }
    // if a Delete activity hits the inbox, it might a deletion of a comment
    if (req.body && req.body.type === 'Delete') {
      _handleDelete(req, res);
    }
    // if we are CC'ed on a public or unlisted Create/Note, then this is a comment to us we should boost (Announce) to our followers
    if (req.body && req.body.type === 'Create' && req.body.object && req.body.object.type === 'Note' && req.body.object.to) {
      _handleCreateNoteComment(req, res);
    } // CC'ed
  }
  catch(e) {
    console.log('Error in processing inbox:', e)
  }
}

function createWebfinger(eventID, domain) {
  return {
    'subject': `acct:${eventID}@${domain}`,

    'links': [
      {
        'rel': 'self',
        'type': 'application/activity+json',
        'href': `https://${domain}/${eventID}`
      }
    ]
  };
}

module.exports = {
  processInbox,
  sendAcceptMessage,
  sendDirectMessage,
  broadcastAnnounceMessage,
  broadcastUpdateMessage,
  broadcastDeleteMessage,
  broadcastCreateMessage,
  signAndSend,
  createActivityPubActor,
  updateActivityPubActor,
  createActivityPubEvent,
  updateActivityPubEvent,
  createFeaturedPost,
  createWebfinger,
}
