/*
 * Copyright 2014-2017,2026 Con Kolivas
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation; either version 3 of the License, or (at your option)
 * any later version.  See COPYING for more details.
 */

#include "config.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <string.h>
#include <unistd.h>

#include "ckpool.h"
#include "libckpool.h"
#include "uthash.h"
#include "utlist.h"
#include "stratifier.h"
#include "generator.h"

#define MAX_MSGSIZE 1024

typedef struct client_instance client_instance_t;
typedef struct sender_send sender_send_t;
typedef struct share share_t;
typedef struct redirect redirect_t;

struct client_instance {
	/* For clients hashtable */
	UT_hash_handle hh;
	int64_t id;

	/* fd cannot be changed while a ref is held */
	int fd;

	/* Reference count for when this instance is used outside of the
	 * connector_data lock */
	int ref;

	/* Have we disabled this client to be removed when there are no refs? */
	bool invalid;

	/* For dead_clients list */
	client_instance_t *dead_next;
	client_instance_t *dead_prev;

	client_instance_t *recycled_next;
	client_instance_t *recycled_prev;


	struct sockaddr_storage address_storage;
	struct sockaddr *address;
	char address_name[INET6_ADDRSTRLEN];

	/* Which serverurl is this instance connected to */
	int server;

	char *buf;
	unsigned long bufofs;

	/* Are we currently sending a blocked message from this client */
	sender_send_t *sending;

	/* Is this a trusted remote server */
	bool remote;

	/* Is this the parent passthrough client */
	bool passthrough;

	/* Linked list of shares in redirector mode.*/
	share_t *shares;

	/* Has this client already been told to redirect */
	bool redirected;
	/* Has this client been authorised in redirector mode */
	bool authorised;

	/* Time this client started blocking, 0 when not blocked */
	time_t blocked_time;

	/* The size of the socket send buffer */
	int sendbufsize;
};

struct sender_send {
	struct sender_send *next;
	struct sender_send *prev;

	client_instance_t *client;
	char *buf;
	int len;
	int ofs;
};

struct share {
	share_t *next;
	share_t *prev;

	time_t submitted;
	int64_t id;
};

struct redirect {
	UT_hash_handle hh;
	char address_name[INET6_ADDRSTRLEN];
	int id;
	int redirect_no;
};

/* Private data for the connector */
struct connector_data {
	cklock_t lock;
	proc_instance_t *pi;

	time_t start_time;

	/* Array of server fds */
	int *serverfd;
	/* All time count of clients connected */
	int nfds;
	/* The epoll fd */
	int epfd;

	bool accept;
	pthread_t pth_sender;
	pthread_t pth_receiver;

	/* For the hashtable of all clients */
	client_instance_t *clients;
	/* Linked list of dead clients no longer in use but may still have references */
	client_instance_t *dead_clients;
	/* Linked list of client structures we can reuse */
	client_instance_t *recycled_clients;

	int clients_generated;
	int dead_generated;

	int64_t client_ids;

	/* client yyjson message process queue */
	ckmsgq_t *cympq;

	/* client message event process queue */
	ckmsgq_t *cevents;

	/* For the linked list of pending sends */
	sender_send_t *sender_sends;

	int64_t sends_generated;
	int64_t sends_delayed;
	int64_t sends_queued;
	int64_t sends_size;

	/* For protecting the pending sends list */
	mutex_t sender_lock;
	pthread_cond_t sender_cond;

	/* Hash list of all redirected IP address in redirector mode */
	redirect_t *redirects;
	/* What redirect we're currently up to */
	int redirect;

	/* Pending sends to the upstream server */
	ckmsgq_t *upstream_sends;
	connsock_t upstream_cs;

	/* Have we given the warning about inability to raise sendbuf size */
	bool wmem_warn;
};

typedef struct connector_data cdata_t;

void connector_upstream_msg(char *msg)
{
	cdata_t *cdata = ckpool.cdata;

	LOGDEBUG("Upstreaming %s", msg);
	ckmsgq_add(cdata->upstream_sends, msg);
}

/* Increase the reference count of instance */
static void __inc_instance_ref(client_instance_t *client)
{
	client->ref++;
}

static void inc_instance_ref(cdata_t *cdata, client_instance_t *client)
{
	ck_wlock(&cdata->lock);
	__inc_instance_ref(client);
	ck_wunlock(&cdata->lock);
}

/* Increase the reference count of instance */
static void __dec_instance_ref(client_instance_t *client)
{
	client->ref--;
}

static void dec_instance_ref(cdata_t *cdata, client_instance_t *client)
{
	ck_wlock(&cdata->lock);
	__dec_instance_ref(client);
	ck_wunlock(&cdata->lock);
}

/* Recruit a client structure from a recycled one if available, creating a
 * new structure only if we have none to reuse. */
static client_instance_t *recruit_client(cdata_t *cdata)
{
	client_instance_t *client = NULL;

	ck_wlock(&cdata->lock);
	if (cdata->recycled_clients) {
		client = cdata->recycled_clients;
		DL_DELETE2(cdata->recycled_clients, client, recycled_prev, recycled_next);
	} else
		cdata->clients_generated++;
	ck_wunlock(&cdata->lock);

	if (!client) {
		LOGDEBUG("Connector created new client instance");
		client = ckzalloc(sizeof(client_instance_t));
	} else
		LOGDEBUG("Connector recycled client instance");

	client->buf = ckzalloc(PAGESIZE);

	return client;
}

static void __recycle_client(cdata_t *cdata, client_instance_t *client)
{
	share_t *share, *tmp;

	dealloc(client->buf);
	DL_FOREACH_SAFE(client->shares, share, tmp)
	    dealloc(share);

	memset(client, 0, sizeof(client_instance_t));
	client->id = -1;
	DL_APPEND2(cdata->recycled_clients, client, recycled_prev, recycled_next);
}

static void recycle_client(cdata_t *cdata, client_instance_t *client)
{
	ck_wlock(&cdata->lock);
	__recycle_client(cdata, client);
	ck_wunlock(&cdata->lock);
}

/* Allows the stratifier to get a unique local virtualid for subclients */
int64_t connector_newclientid(void)
{
	int64_t ret;

	cdata_t *cdata = ckpool.cdata;

	ck_wlock(&cdata->lock);
	ret = cdata->client_ids++;
	ck_wunlock(&cdata->lock);

	return ret;
}

/* Accepts incoming connections on the server socket and generates client
 * instances */
static int accept_client(cdata_t *cdata, const int epfd, const uint64_t server)
{
	int fd, port, no_clients, sockd;
	client_instance_t *client;
	struct epoll_event event;
	socklen_t address_len;
	socklen_t optlen;

	ck_rlock(&cdata->lock);
	no_clients = HASH_COUNT(cdata->clients);
	ck_runlock(&cdata->lock);

	if (unlikely(ckpool.maxclients && no_clients >= ckpool.maxclients)) {
		LOGWARNING("Server full with %d clients", no_clients);
		return 0;
	}

	sockd = cdata->serverfd[server];
	client = recruit_client(cdata);
	client->server = server;
	client->address = (struct sockaddr *)&client->address_storage;
	address_len = sizeof(client->address_storage);
	fd = accept(sockd, client->address, &address_len);
	if (unlikely(fd < 0)) {
		/* Handle these errors gracefully should we ever share this
		 * socket */
		if (errno == EAGAIN || errno == EWOULDBLOCK || errno == ECONNABORTED) {
			LOGNOTICE("Recoverable error on accept in accept_client");
			return 0;
		}
		LOGERR("Failed to accept on socket %d in acceptor", sockd);
		recycle_client(cdata, client);
		return -1;
	}

	switch (client->address->sa_family) {
		const struct sockaddr_in *inet4_in;
		const struct sockaddr_in6 *inet6_in;

		case AF_INET:
			inet4_in = (struct sockaddr_in *)client->address;
			inet_ntop(AF_INET, &inet4_in->sin_addr, client->address_name, INET6_ADDRSTRLEN);
			port = htons(inet4_in->sin_port);
			break;
		case AF_INET6:
			inet6_in = (struct sockaddr_in6 *)client->address;
			inet_ntop(AF_INET6, &inet6_in->sin6_addr, client->address_name, INET6_ADDRSTRLEN);
			port = htons(inet6_in->sin6_port);
			break;
		default:
			LOGWARNING("Unknown INET type for client %d on socket %d",
				   cdata->nfds, fd);
			Close(fd);
			recycle_client(cdata, client);
			return 0;
	}

	keep_sockalive(fd);
	noblock_socket(fd);

	LOGINFO("Connected new client %d on socket %d to %d active clients from %s:%d",
		cdata->nfds, fd, no_clients, client->address_name, port);

	ck_wlock(&cdata->lock);
	client->id = cdata->client_ids++;
	HASH_ADD_I64(cdata->clients, id, client);
	cdata->nfds++;
	ck_wunlock(&cdata->lock);

	/* We increase the ref count on this client as epoll creates a pointer
	 * to it. We drop that reference when the socket is closed which
	 * removes it automatically from the epoll list. */
	__inc_instance_ref(client);
	client->fd = fd;
	optlen = sizeof(client->sendbufsize);
	getsockopt(fd, SOL_SOCKET, SO_RCVBUF, &client->sendbufsize, &optlen);
	LOGDEBUG("Client sendbufsize detected as %d", client->sendbufsize);

	event.data.u64 = client->id;
	event.events = EPOLLIN | EPOLLRDHUP | EPOLLONESHOT;
	if (unlikely(epoll_ctl(epfd, EPOLL_CTL_ADD, fd, &event) < 0)) {
		LOGERR("Failed to epoll_ctl add in accept_client");
		dec_instance_ref(cdata, client);
		return 0;
	}

	return 1;
}

static int __drop_client(cdata_t *cdata, client_instance_t *client)
{
	int ret = -1;

	if (client->invalid)
		goto out;
	client->invalid = true;
	ret = client->fd;
	/* Closing the fd will automatically remove it from the epoll list */
	Close(client->fd);
	HASH_DEL(cdata->clients, client);
	DL_APPEND2(cdata->dead_clients, client, dead_prev, dead_next);
	/* This is the reference to this client's presence in the
	 * epoll list. */
	__dec_instance_ref(client);
	cdata->dead_generated++;
out:
	return ret;
}

static void stratifier_drop_id(const int64_t id)
{
	char buf[256];

	sprintf(buf, "dropclient=%"PRId64, id);
	send_proc(ckpool.stratifier, buf);
}

/* Client must hold a reference count */
static int drop_client(cdata_t *cdata, client_instance_t *client)
{
	bool passthrough = client->passthrough, remote = client->remote;
	char address_name[INET6_ADDRSTRLEN];
	int64_t client_id = client->id;
	int fd = -1;

	strcpy(address_name, client->address_name);
	ck_wlock(&cdata->lock);
	fd = __drop_client(cdata, client);
	ck_wunlock(&cdata->lock);

	if (fd > -1) {
		if (passthrough) {
			LOGNOTICE("Connector dropped passthrough %"PRId64" %s",
				  client_id, address_name);
		} else if (remote) {
			LOGWARNING("Remote trusted server client %"PRId64" %s disconnected",
				   client_id, address_name);
		}
		LOGDEBUG("Connector dropped fd %d", fd);
		stratifier_drop_id(client_id);
	}

	return fd;
}

/* For sending the drop command to the upstream pool in passthrough mode */
static void generator_drop_client(const client_instance_t *client)
{
	json_t *val;

	JSON_CPACK(val, "{si,sI:ss:si:ss:s[]}", "id", 42, "client_id", client->id, "address",
		   client->address_name, "server", client->server, "method", "mining.term",
		   "params");
	generator_add_send(val);
}

static void stratifier_drop_client(const client_instance_t *client)
{
	stratifier_drop_id(client->id);
}

/* Invalidate this instance. Remove them from the hashtables we look up
 * regularly but keep the instances in a linked list until their ref count
 * drops to zero when we can remove them lazily. Client must hold a reference
 * count. */
static int invalidate_client(cdata_t *cdata, client_instance_t *client)
{
	client_instance_t *tmp;
	int ret;

	ret = drop_client(cdata, client);
	if ((!ckpool.passthrough || ckpool.node) && !client->passthrough)
		stratifier_drop_client(client);
	if (ckpool.passthrough)
		generator_drop_client(client);

	/* Cull old unused clients lazily when there are no more reference
	 * counts for them. */
	ck_wlock(&cdata->lock);
	DL_FOREACH_SAFE2(cdata->dead_clients, client, tmp, dead_next) {
		if (!client->ref) {
			DL_DELETE2(cdata->dead_clients, client, dead_prev, dead_next);
			LOGINFO("Connector recycling client %"PRId64, client->id);
			/* We only close the client fd once we're sure there
			 * are no references to it left to prevent fds being
			 * reused on new and old clients. */
			nolinger_socket(client->fd);
			Close(client->fd);
			__recycle_client(cdata, client);
		}
	}
	ck_wunlock(&cdata->lock);

	return ret;
}

static void drop_all_clients(cdata_t *cdata)
{
	client_instance_t *client, *tmp;

	ck_wlock(&cdata->lock);
	HASH_ITER(hh, cdata->clients, client, tmp) {
		__drop_client(cdata, client);
	}
	ck_wunlock(&cdata->lock);
}

static void send_client(cdata_t *cdata, int64_t id, char *buf);

/* Look for shares being submitted via a redirector and add them to a linked
 * list for looking up the responses. */
static void parse_redirector_share(cdata_t *cdata, client_instance_t *client, const json_t *val)
{
	share_t *share, *tmp;
	time_t now;
	int64_t id;

	if (!json_get_int64(&id, val, "id")) {
		LOGNOTICE("Failed to find redirector share id");
		return;
	}
	share = ckzalloc(sizeof(share_t));
	now = time(NULL);
	share->submitted = now;
	share->id = id;

	LOGINFO("Redirector adding client %"PRId64" share id: %"PRId64, client->id, id);

	/* We use the cdata lock instead of a separate lock since this function
	 * is called infrequently. */
	ck_wlock(&cdata->lock);
	DL_APPEND(client->shares, share);

	/* Age old shares. */
	DL_FOREACH_SAFE(client->shares, share, tmp) {
		if (now > share->submitted + 120) {
			DL_DELETE(client->shares, share);
			dealloc(share);
		}
	}
	ck_wunlock(&cdata->lock);
}

/* Client is holding a reference count from being on the epoll list. Returns
 * true if we will still be receiving messages from this client. */
static bool parse_client_msg(cdata_t *cdata, client_instance_t *client)
{
	yyjson_doc *sdoc;
	int buflen, ret;
	char *eol;

retry:
	if (unlikely(client->bufofs > MAX_MSGSIZE)) {
		if (!client->remote) {
			LOGNOTICE("Client id %"PRId64" fd %d overloaded buffer without EOL, disconnecting",
				client->id, client->fd);
			return false;
		}
		client->buf = realloc(client->buf, round_up_page(client->bufofs + MAX_MSGSIZE + 1));
	}
	/* This read call is non-blocking since the socket is set to O_NOBLOCK */
	ret = read(client->fd, client->buf + client->bufofs, MAX_MSGSIZE);
	if (ret < 1) {
		if (likely(errno == EAGAIN || errno == EWOULDBLOCK || !ret))
			return true;
		LOGINFO("Client id %"PRId64" fd %d disconnected - recv fail with bufofs %lu ret %d errno %d %s",
			client->id, client->fd, client->bufofs, ret, errno, ret && errno ? strerror(errno) : "");
		return false;
	}
	client->bufofs += ret;
reparse:
	eol = memchr(client->buf, '\n', client->bufofs);
	if (!eol)
		goto retry;

	/* Do something useful with this message now */
	buflen = eol - client->buf + 1;
	if (unlikely(buflen > MAX_MSGSIZE && !client->remote)) {
		LOGNOTICE("Client id %"PRId64" fd %d message oversize, disconnecting", client->id, client->fd);
		return false;
	}

	/* Filter out non- or incomplete json */
	if (unlikely(client->buf[0] != '{' ||
	    !(sdoc = yyjson_read(client->buf, strlen(client->buf), YYJSON_READ_STOP_WHEN_DONE)))) {
		char *buf = strdup("Invalid JSON, disconnecting\n");

		LOGINFO("Client id %"PRId64" sent invalid json message %s", client->id, client->buf);
		send_client(cdata, client->id, buf);
		return false;
	} else {
		yyjson_mut_doc *doc = yyjson_doc_mut_copy(sdoc, &ckyyalc);
		yyjson_mut_val *root = yyjson_mut_doc_get_root(doc);

		yyjson_doc_free(sdoc);

		if (client->passthrough) {
			int64_t passthrough_id;

			passthrough_id = yyjson_mut_get_num(yyjson_mut_obj_get(root, "client_id"));
			passthrough_id = (client->id << 32) | passthrough_id;
			yyjson_mut_obj_remove_key(root, "client_id");
			yyjson_mut_obj_add_sint(doc, root, "client_id", passthrough_id);
		} else {
			if (ckpool.redirector && !client->redirected && strstr(client->buf, "mining.submit")) {
				json_t *val = yyjson_to_json(doc);

				parse_redirector_share(cdata, client, val);
				json_decref(val);
			}
			yyjson_mut_obj_add_sint(doc, root, "client_id", client->id);
			yyjson_mut_obj_add_str(doc, root, "address", client->address_name);
		}
		yyjson_mut_obj_add_sint(doc, root, "server", client->server);

		/* Do not send messages of clients we've already dropped. We
		 * do this unlocked as the occasional false negative can be
		 * filtered by the stratifier. */
		if (likely(!client->invalid)) {
			if (!ckpool.passthrough)
				stratifier_add_yyrecv(doc);
			else if (ckpool.node)
				stratifier_add_yyrecv(doc);
			else if (ckpool.passthrough) {
				generator_add_send(yyjson_to_json(doc));
				yyjson_mut_doc_free(doc);
			}
		} else
			yyjson_mut_doc_free(doc);
	}
	client->bufofs -= buflen;
	if (client->bufofs)
		memmove(client->buf, client->buf + buflen, client->bufofs);
	client->buf[client->bufofs] = '\0';

	if (client->bufofs)
		goto reparse;
	goto retry;
}

static client_instance_t *ref_client_by_id(cdata_t *cdata, int64_t id)
{
	client_instance_t *client;

	ck_wlock(&cdata->lock);
	HASH_FIND_I64(cdata->clients, &id, client);
	if (client) {
		if (!client->invalid)
			__inc_instance_ref(client);
		else
			client = NULL;
	}
	ck_wunlock(&cdata->lock);

	return client;
}

static void add_remote_client(cdata_t *cdata, int64_t id)
{
	client_instance_t *client;
	yyjson_mut_doc *doc;
	bool found = false;
	char *buf;

	ck_wlock(&cdata->lock);
	HASH_FIND_I64(cdata->clients, &id, client);
	if (likely(client)) {
		found = true;
		client->remote = true;
	}
	ck_wunlock(&cdata->lock);

	if (likely(found))
		LOGWARNING("Added trusted remote client %ld", id);
	else
		LOGWARNING("Unable to find trusted remote client %ld", id);
	doc = yyjson_mut_pack("{sb}", "result", found);
	buf = yyjson_mut_write(doc, YYJSON_WRITE_NEWLINE_AT_END, NULL);
	yyjson_mut_doc_free(doc);
	send_client(cdata, id, buf);
}

static void redirect_client(client_instance_t *client);

static bool redirect_matches(cdata_t *cdata, client_instance_t *client)
{
	redirect_t *redirect;

	ck_rlock(&cdata->lock);
	HASH_FIND_STR(cdata->redirects, client->address_name, redirect);
	ck_runlock(&cdata->lock);

	return redirect;
}

static void client_event_processor(struct epoll_event *event)
{
	const uint32_t events = event->events;
	const uint64_t id = event->data.u64;
	cdata_t *cdata = ckpool.cdata;
	client_instance_t *client;

	client = ref_client_by_id(cdata, id);
	if (unlikely(!client)) {
		LOGNOTICE("Failed to find client by id %"PRId64" in receiver!", id);
		goto outnoclient;
	}
	/* We can have both messages and read hang ups so process the
	 * message first. */
	if (likely(events & EPOLLIN)) {
		/* Rearm the client for epoll events if we have successfully
		 * parsed a message from it */
		if (unlikely(!parse_client_msg(cdata, client))) {
			invalidate_client(cdata, client);
			goto out;
		}
	}
	if (unlikely(events & EPOLLERR)) {
		socklen_t errlen = sizeof(int);
		int error = 0;

		/* See what type of error this is and raise the log
			* level of the message if it's unexpected. */
		getsockopt(client->fd, SOL_SOCKET, SO_ERROR, (void *)&error, &errlen);
		if (error != 104) {
			LOGNOTICE("Client id %"PRId64" fd %d epollerr HUP in epoll with errno %d: %s",
					client->id, client->fd, error, strerror(error));
		} else {
			LOGINFO("Client id %"PRId64" fd %d epollerr HUP in epoll with errno %d: %s",
				client->id, client->fd, error, strerror(error));
		}
		invalidate_client(cdata, client);
	} else if (unlikely(events & EPOLLHUP)) {
		/* Client connection reset by peer */
		LOGINFO("Client id %"PRId64" fd %d HUP in epoll", client->id, client->fd);
		invalidate_client(cdata, client);
	} else if (unlikely(events & EPOLLRDHUP)) {
		/* Client disconnected by peer */
		LOGINFO("Client id %"PRId64" fd %d RDHUP in epoll", client->id, client->fd);
		invalidate_client(cdata, client);
	}
out:
	if (likely(!client->invalid)) {
		/* Rearm the fd in the epoll list if it's still active */
		event->data.u64 = id;
		event->events = EPOLLIN | EPOLLRDHUP | EPOLLONESHOT;
		epoll_ctl(cdata->epfd, EPOLL_CTL_MOD, client->fd, event);
	}
	dec_instance_ref(cdata, client);
outnoclient:
	free(event);
}

/* Waits on fds ready to read on from the list stored in conn_instance and
 * handles the incoming messages */
static void *receiver(void *arg)
{
	cdata_t *cdata = (cdata_t *)arg;
	struct epoll_event *event = ckzalloc(sizeof(struct epoll_event));
	uint64_t serverfds, i;
	int ret, epfd;

	rename_proc("creceiver");

	epfd = cdata->epfd = epoll_create1(EPOLL_CLOEXEC);
	if (epfd < 0) {
		LOGEMERG("FATAL: Failed to create epoll in receiver");
		goto out;
	}
	serverfds = ckpool.serverurls;
	/* Add all the serverfds to the epoll */
	for (i = 0; i < serverfds; i++) {
		/* The small values will be less than the first client ids */
		event->data.u64 = i;
		event->events = EPOLLIN | EPOLLRDHUP;
		ret = epoll_ctl(epfd, EPOLL_CTL_ADD, cdata->serverfd[i], event);
		if (ret < 0) {
			LOGEMERG("FATAL: Failed to add epfd %d to epoll_ctl", epfd);
			goto out;
		}
	}

	/* Wait for the stratifier to be ready for us */
	while (!ckpool.stratifier_ready)
		cksleep_ms(10);

	while (42) {
		uint64_t edu64;

		while (unlikely(!cdata->accept))
			cksleep_ms(10);
		ret = epoll_wait(epfd, event, 1, 1000);
		if (unlikely(ret < 1)) {
			if (unlikely(ret == -1)) {
				LOGEMERG("FATAL: Failed to epoll_wait in receiver");
				break;
			}
			/* Nothing to service, still very unlikely */
			continue;
		}
		edu64 = event->data.u64;
		if (edu64 < serverfds) {
			ret = accept_client(cdata, epfd, edu64);
			if (unlikely(ret < 0)) {
				LOGEMERG("FATAL: Failed to accept_client in receiver");
				break;
			}
			continue;
		}
		/* Event structure is handed off to client_event_processor
		 * here to be freed so we need to allocate a new one */
		ckmsgq_add(cdata->cevents, event);
		event = ckzalloc(sizeof(struct epoll_event));
	}
out:
	/* We shouldn't get here unless there's an error */
	return NULL;
}

/* Send a sender_send message and return true if we've finished sending it or
 * are unable to send any more. */
static bool send_sender_send(cdata_t *cdata, sender_send_t *sender_send)
{
	client_instance_t *client = sender_send->client;
	time_t now_t;

	if (unlikely(client->invalid))
		goto out_true;

	/* Make sure we only send one message at a time to each client */
	if (unlikely(client->sending && client->sending != sender_send))
		return false;

	client->sending = sender_send;
	now_t = time(NULL);

	/* Increase sendbufsize to match large messages sent to clients - this
	 * usually only applies to clients as mining nodes. */
	if (unlikely(!ckpool.wmem_warn && sender_send->len > client->sendbufsize))
		client->sendbufsize = set_sendbufsize(client->fd, sender_send->len);

	while (sender_send->len) {
		int ret = write(client->fd, sender_send->buf + sender_send->ofs, sender_send->len);

		if (ret < 1) {
			/* Invalidate clients that block for more than 60 seconds */
			if (unlikely(client->blocked_time && now_t - client->blocked_time >= 60)) {
				LOGNOTICE("Client id %"PRId64" fd %d blocked for >60 seconds, disconnecting",
					  client->id, client->fd);
				invalidate_client(cdata, client);
				goto out_true;
			}
			if (errno == EAGAIN || errno == EWOULDBLOCK || !ret) {
				if (!client->blocked_time)
					client->blocked_time = now_t;
				return false;
			}
			LOGINFO("Client id %"PRId64" fd %d disconnected with write errno %d:%s",
				client->id, client->fd, errno, strerror(errno));
			invalidate_client(cdata, client);
			goto out_true;
		}
		sender_send->ofs += ret;
		sender_send->len -= ret;
		client->blocked_time = 0;
	}
out_true:
	client->sending = NULL;
	return true;
}

static void clear_sender_send(sender_send_t *sender_send, cdata_t *cdata)
{
	dec_instance_ref(cdata, sender_send->client);
	free(sender_send->buf);
	free(sender_send);
}

/* Use a thread to send queued messages, appending them to the sends list and
 * iterating over all of them, attempting to send them all non-blocking to
 * only send to those clients ready to receive data. */
static void *sender(void *arg)
{
	cdata_t *cdata = (cdata_t *)arg;
	sender_send_t *sends = NULL;

	rename_proc("csender");

	while (42) {
		int64_t sends_queued = 0, sends_size = 0;
		sender_send_t *sending, *tmp;

		/* Check all sends to see if they can be written out */
		DL_FOREACH_SAFE(sends, sending, tmp) {
			if (send_sender_send(cdata, sending)) {
				DL_DELETE(sends, sending);
				clear_sender_send(sending, cdata);
			} else {
				sends_queued++;
				sends_size += sizeof(sender_send_t) + sending->len + 1;
			}
		}

		mutex_lock(&cdata->sender_lock);
		cdata->sends_delayed += sends_queued;
		cdata->sends_queued = sends_queued;
		cdata->sends_size = sends_size;
		/* Poll every 10ms if there are no new sends. */
		if (!cdata->sender_sends) {
			const ts_t polltime = {0, 10000000};
			ts_t timeout_ts;

			ts_realtime(&timeout_ts);
			timeraddspec(&timeout_ts, &polltime);
			cond_timedwait(&cdata->sender_cond, &cdata->sender_lock, &timeout_ts);
		}
		if (cdata->sender_sends) {
			DL_CONCAT(sends, cdata->sender_sends);
			cdata->sender_sends = NULL;
		}
		mutex_unlock(&cdata->sender_lock);
	}
	/* We shouldn't get here unless there's an error */
	return NULL;
}

static int add_redirect(cdata_t *cdata, client_instance_t *client)
{
	redirect_t *redirect;
	bool found;

	ck_wlock(&cdata->lock);
	HASH_FIND_STR(cdata->redirects, client->address_name, redirect);
	if (!redirect) {
		redirect = ckzalloc(sizeof(redirect_t));
		strcpy(redirect->address_name, client->address_name);
		redirect->redirect_no = cdata->redirect++;
		if (cdata->redirect >= ckpool.redirecturls)
			cdata->redirect = 0;
		HASH_ADD_STR(cdata->redirects, address_name, redirect);
		found = false;
	} else
		found = true;
	ck_wunlock(&cdata->lock);

	LOGNOTICE("Redirecting client %"PRId64" from %s IP %s to redirecturl %d",
		  client->id, found ? "matching" : "new", client->address_name, redirect->redirect_no);
	return redirect->redirect_no;
}

static void redirect_client(client_instance_t *client)
{
	sender_send_t *sender_send;
	cdata_t *cdata = ckpool.cdata;
	json_t *val;
	char *buf;
	int num;

	/* Set the redirected boool to only try redirecting them once */
	client->redirected = true;

	num = add_redirect(cdata, client);
	JSON_CPACK(val, "{sosss[ssi]}", "id", json_null(), "method", "client.reconnect",
		   "params", ckpool.redirecturl[num], ckpool.redirectport[num], 0);
	buf = json_dumps(val, JSON_EOL | JSON_COMPACT);
	json_decref(val);

	sender_send = ckzalloc(sizeof(sender_send_t));
	sender_send->client = client;
	sender_send->buf = buf;
	sender_send->len = strlen(buf);
	inc_instance_ref(cdata, client);

	mutex_lock(&cdata->sender_lock);
	cdata->sends_generated++;
	DL_APPEND(cdata->sender_sends, sender_send);
	pthread_cond_signal(&cdata->sender_cond);
	mutex_unlock(&cdata->sender_lock);
}

/* Look for accepted shares in redirector mode to know we can redirect this
 * client to a protected server. */
static bool test_redirector_shares(cdata_t *cdata, client_instance_t *client, const char *buf)
{
	json_t *val = json_loads(buf, 0, NULL);
	share_t *share, *found = NULL;
	bool ret = false;
	int64_t id;

	if (!val) {
		/* Can happen when responding to invalid json from client */
		LOGINFO("Invalid json response to client %"PRId64 "%s", client->id, buf);
		return ret;
	}
	if (!json_get_int64(&id, val, "id")) {
		LOGINFO("Failed to find response id");
		goto out;
	}

	ck_rlock(&cdata->lock);
	DL_FOREACH(client->shares, share) {
		if (share->id == id) {
			LOGDEBUG("Found matching share %"PRId64" in trs for client %"PRId64,
				 id, client->id);
			found = share;
			break;
		}
	}
	ck_runlock(&cdata->lock);

	if (found) {
		bool result = false;

		{
			json_t *res_val = json_object_get(val, "result");

			if (!json_is_boolean(res_val)) {
				json_t *err_val = json_object_get(val, "error");

				if (unlikely(!(json_is_null(res_val) && err_val && !json_is_null(err_val)))) {
					LOGINFO("Failed to find result in trs share");
					goto out;
				}
				result = false;
			} else
				result = json_is_true(res_val);
		}
		if (!json_is_null(json_object_get(val, "error"))) {
			LOGINFO("Got error for trs share");
			goto out;
		}
		if (!result) {
			LOGDEBUG("Rejected trs share");
			goto out;
		}
		LOGNOTICE("Found accepted share for client %"PRId64" - redirecting",
			   client->id);
		ret = true;

		/* Clear the list now since we don't need it any more */
		ck_wlock(&cdata->lock);
		DL_FOREACH_SAFE(client->shares, share, found) {
			DL_DELETE(client->shares, share);
			dealloc(share);
		}
		ck_wunlock(&cdata->lock);
	}
out:
	json_decref(val);
	return ret;
}

/* Send a client by id a heap allocated buffer, allowing this function to
 * free the ram. */
static void send_client(cdata_t *cdata, const int64_t id, char *buf)
{
	sender_send_t *sender_send;
	client_instance_t *client;
	bool redirect = false;
	int64_t pass_id;
	int len;

	if (unlikely(!buf)) {
		LOGWARNING("Connector send_client sent a null buffer");
		return;
	}
	len = strlen(buf);
	if (unlikely(!len)) {
		LOGWARNING("Connector send_client sent a zero length buffer");
		free(buf);
		return;
	}

	if (unlikely(ckpool.node && !id)) {
		LOGDEBUG("Message for node: %s", buf);
		send_proc(ckpool.stratifier, buf);
		free(buf);
		return;
	}

	/* Grab a reference to this client until the sender_send has
	 * completed processing. Is this a passthrough subclient ? */
	if ((pass_id = subclient(id))) {
		int64_t client_id = id & 0xffffffffll;

		/* Make sure the passthrough exists for passthrough subclients */
		client = ref_client_by_id(cdata, pass_id);
		if (unlikely(!client)) {
			LOGINFO("Connector failed to find passthrough id %"PRId64" of client id %"PRId64" to send to",
				pass_id, client_id);
			/* Now see if the subclient exists */
			client = ref_client_by_id(cdata, client_id);
			if (client) {
				invalidate_client(cdata, client);
				dec_instance_ref(cdata, client);
			} else
				stratifier_drop_id(id);
			free(buf);
			return;
		}
	} else {
		client = ref_client_by_id(cdata, id);
		if (unlikely(!client)) {
			LOGINFO("Connector failed to find client id %"PRId64" to send to", id);
			stratifier_drop_id(id);
			free(buf);
			return;
		}
		if (ckpool.redirector && !client->redirected && client->authorised) {
			/* If clients match the IP of clients that have already
			 * been whitelisted as finding valid shares then
			 * redirect them immediately. */
			if (redirect_matches(cdata, client))
				redirect = true;
			else
				redirect = test_redirector_shares(cdata, client, buf);
		}
	}

	sender_send = ckzalloc(sizeof(sender_send_t));
	sender_send->client = client;
	sender_send->buf = buf;
	sender_send->len = len;

	mutex_lock(&cdata->sender_lock);
	cdata->sends_generated++;
	DL_APPEND(cdata->sender_sends, sender_send);
	pthread_cond_signal(&cdata->sender_cond);
	mutex_unlock(&cdata->sender_lock);

	/* Redirect after sending response to shares and authorise */
	if (unlikely(redirect))
		redirect_client(client);
}

static void
_send_client_yyjson(cdata_t *cdata, int64_t client_id, yyjson_mut_doc *doc,
		    const char *file, const char *func, const int line)
{
	client_instance_t *client;
	char *msg;

	if (unlikely(!doc)) {
		LOGWARNING("_send_client_yyjson received NULL doc from %s %s:%d", file, func, line);
		return;
	}

	if (ckpool.node && (client = ref_client_by_id(cdata, client_id))) {
		yyjson_mut_doc *tmp_doc = yyjson_mut_doc_mut_copy(doc, &ckyyalc);
		yyjson_mut_val *root = yyjson_mut_doc_get_root(tmp_doc);

		yyjson_mut_obj_add_sint(tmp_doc, root, "client_id", client_id);
		yyjson_mut_obj_add_str(tmp_doc, root, "address", client->address_name);
		yyjson_mut_obj_add_sint(tmp_doc, root, "server", client->server);
		dec_instance_ref(cdata, client);
		stratifier_add_yyrecv(tmp_doc);
	}
	msg = yyjson_mut_write(doc, YYJSON_WRITE_NEWLINE_AT_END, NULL);
	send_client(cdata, client_id, msg);
	yyjson_mut_doc_free(doc);
}

#define send_client_yyjson(cdata, client_id, doc) \
	_send_client_yyjson(cdata, client_id, doc, __FILE__, __func__, __LINE__)

/* When testing if a client exists, passthrough clients don't exist when their
 * parent no longer exists. */
static bool client_exists(cdata_t *cdata, int64_t id)
{
	int64_t parent_id = subclient(id);
	client_instance_t *client;

	if (parent_id)
		id = parent_id;

	ck_rlock(&cdata->lock);
	HASH_FIND_I64(cdata->clients, &id, client);
	ck_runlock(&cdata->lock);

	return !!client;
}

static void passthrough_client(cdata_t *cdata, client_instance_t *client)
{
	yyjson_mut_doc *doc;

	LOGINFO("Connector adding passthrough client %"PRId64, client->id);
	client->passthrough = true;
	doc = yyjson_mut_pack("{sb}", "result", true);
	send_client_yyjson(cdata, client->id, doc);
	if (!ckpool.rmem_warn)
		set_recvbufsize(client->fd, 1048576);
	if (!ckpool.wmem_warn)
		client->sendbufsize = set_sendbufsize(client->fd, 1048576);
}

static bool connect_upstream(connsock_t *cs)
{
	json_t *req, *val = NULL, *res_val, *err_val;
	bool res, ret = false;
	float timeout = 10;

	cksem_wait(&cs->sem);
	cs->fd = connect_socket(cs->url, cs->port);
	if (cs->fd < 0) {
		LOGWARNING("Failed to connect to upstream server %s:%s", cs->url, cs->port);
		goto out;
	}
	keep_sockalive(cs->fd);

	/* We want large send buffers for upstreaming messages */
	if (!ckpool.rmem_warn)
		set_recvbufsize(cs->fd, 2097152);
	if (!ckpool.wmem_warn)
		cs->sendbufsiz = set_sendbufsize(cs->fd, 2097152);

	JSON_CPACK(req, "{ss,s[s]}",
			"method", "mining.remote",
			"params", PACKAGE"/"VERSION);
	res = send_json_msg(cs, req);
	json_decref(req);
	if (!res) {
		LOGWARNING("Failed to send message in connect_upstream");
		goto out;
	}
	if (read_socket_line(cs, &timeout) < 1) {
		LOGWARNING("Failed to receive line in connect_upstream");
		goto out;
	}
	val = json_msg_result(cs->buf, &res_val, &err_val);
	if (!val || !res_val) {
		LOGWARNING("Failed to get a json result in connect_upstream, got: %s",
			 cs->buf);
		goto out;
	}
	ret = json_is_true(res_val);
	if (!ret) {
		LOGWARNING("Denied upstream trusted connection");
		goto out;
	}
	LOGWARNING("Connected to upstream server %s:%s as trusted remote",
		   cs->url, cs->port);
	ret = true;
out:
	if (val)
		json_decref(val);
	cksem_post(&cs->sem);

	return ret;
}

static void usend_process(char *buf)
{
	cdata_t *cdata = ckpool.cdata;
	connsock_t *cs = &cdata->upstream_cs;
	int len, sent;

	if (unlikely(!buf || !strlen(buf))) {
		LOGERR("Send empty message to usend_process");
		goto out;
	}
	LOGDEBUG("Sending upstream msg: %s", buf);
	len = strlen(buf);
	while (42) {
		sent = write_socket(cs->fd, buf, len);
		if (sent == len)
			break;
		if (cs->fd > 0) {
			LOGWARNING("Upstream pool failed, attempting reconnect while caching messages");
			Close(cs->fd);
		}
		do
			sleep(5);
		while (!connect_upstream(cs));
	}
out:
	free(buf);
}

static void ping_upstream(cdata_t *cdata)
{
	char *buf;

	ASPRINTF(&buf, "{\"method\":\"ping\"}\n");
	ckmsgq_add(cdata->upstream_sends, buf);
}

static void *urecv_process(void __maybe_unused *arg)
{
	cdata_t *cdata = ckpool.cdata;
	connsock_t *cs = &cdata->upstream_cs;
	bool alive = true;

	rename_proc("ureceiver");

	pthread_detach(pthread_self());

	while (42) {
		const char *method;
		float timeout = 5;
		json_t *val;
		int ret;

		cksem_wait(&cs->sem);
		ret = read_socket_line(cs, &timeout);
		if (ret < 1) {
			ping_upstream(cdata);
			if (likely(!ret)) {
				LOGDEBUG("No message from upstream pool");
			} else {
				LOGNOTICE("Failed to read from upstream pool");
				alive = false;
			}
			goto nomsg;
		}
		alive = true;
		val = json_loads(cs->buf, 0, NULL);
		if (unlikely(!val)) {
			LOGWARNING("Received non-json msg from upstream pool %s",
				   cs->buf);
			goto nomsg;
		}
		method = json_string_value(json_object_get(val, "method"));
		if (unlikely(!method)) {
			LOGWARNING("Failed to find method from upstream pool json %s",
				   cs->buf);
			json_decref(val);
			goto decref;
		}
		if (!safecmp(method, stratum_msgs[SM_TRANSACTIONS]))
			parse_upstream_txns(val);
		else if (!safecmp(method, stratum_msgs[SM_AUTHRESULT]))
			parse_upstream_auth(val);
		else if (!safecmp(method, stratum_msgs[SM_WORKINFO]))
			parse_upstream_workinfo(val);
		else if (!safecmp(method, stratum_msgs[SM_BLOCK]))
			parse_upstream_block(val);
		else if (!safecmp(method, stratum_msgs[SM_REQTXNS]))
			parse_upstream_reqtxns(val);
		else if (!safecmp(method, "pong"))
			LOGDEBUG("Received upstream pong");
		else
			LOGWARNING("Unrecognised upstream method %s", method);
decref:
		json_decref(val);
nomsg:
		cksem_post(&cs->sem);

		if (!alive)
			sleep(5);
	}
	return NULL;
}

static bool setup_upstream(cdata_t *cdata)
{
	connsock_t *cs = &cdata->upstream_cs;
	bool ret = false;
	pthread_t pth;

	if (!ckpool.upstream) {
		LOGEMERG("No upstream server set in remote trusted server mode");
		goto out;
	}
	if (!extract_sockaddr(ckpool.upstream, &cs->url, &cs->port)) {
		LOGEMERG("Failed to extract upstream address from %s", ckpool.upstream);
		goto out;
	}

	cksem_init(&cs->sem);
	cksem_post(&cs->sem);

	while (!connect_upstream(cs))
		cksleep_ms(5000);

	create_pthread(&pth, urecv_process, NULL);
	cdata->upstream_sends = create_ckmsgq("usender", &usend_process);
	ret = true;
out:
	return ret;
}

static void client_yymessage_processor(yyjson_mut_doc *doc)
{
	cdata_t *cdata = ckpool.cdata;
	client_instance_t *client;
	yyjson_mut_val *root;
	int64_t client_id;

	if (unlikely(!doc)) {
		LOGWARNING("client_yymessage_processor received NULL doc");
		return;
	}
	root = yyjson_mut_doc_get_root(doc);
	/* Extract the client id from the json message and remove its entry */
	client_id = yyjson_mut_get_num(yyjson_mut_obj_get(root, "client_id"));
	yyjson_mut_obj_remove_key(root, "client_id");
	/* Put client_id back in for a passthrough subclient, passing its
	 * upstream client_id instead of the passthrough's. */
	if (subclient(client_id))
		yyjson_mut_obj_add_sint(doc, root, "client_id", client_id & 0xffffffffll);

	/* Flag redirector clients once they've been authorised */
	if (ckpool.redirector && (client = ref_client_by_id(cdata, client_id))) {
		if (!client->redirected && !client->authorised) {
			yyjson_mut_val *method_val = yyjson_mut_obj_get(root, "node.method");
			const char *method = yyjson_mut_get_str(method_val);

			if (!safecmp(method, stratum_msgs[SM_AUTHRESULT]))
				client->authorised = true;
		}
		dec_instance_ref(cdata, client);
	}
	send_client_yyjson(cdata, client_id, doc);
}

void connector_add_message(json_t *val)
{
	cdata_t *cdata = ckpool.cdata;
	yyjson_mut_doc *doc = json_to_yyjson(val);

	json_decref(val);
	if (likely(doc))
		ckmsgq_add(cdata->cympq, doc);
}

void _connector_add_yymessage(yyjson_mut_doc *doc, const char *file,
			     const char *func, const int line)
{
	cdata_t *cdata = ckpool.cdata;

	if (unlikely(!doc)) {
		LOGWARNING("_connector_add_yymessage received NULL doc from %s %s:%d",
			   file, func, line);
		return;
	}

	ckmsgq_add(cdata->cympq, doc);
}

/* Send the passthrough the terminate node.method */
static void drop_passthrough_client(cdata_t *cdata, const int64_t id)
{
	int64_t client_id;
	char *msg;

	LOGINFO("Asked to drop passthrough client %"PRId64", forwarding to passthrough", id);
	client_id = id & 0xffffffffll;
	/* We have a direct connection to the passthrough's connector so we
	 * can send it any regular commands. */
	ASPRINTF(&msg, "dropclient=%"PRId64"\n", client_id);
	send_client(cdata, id, msg);
}

char *connector_stats(void *data, const int runtime)
{
	json_t *val = json_object(), *subval;
	client_instance_t *client;
	int objects, generated;
	cdata_t *cdata = data;
	sender_send_t *send;
	int64_t memsize;
	char *buf;

	/* If called in passthrough mode we log stats instead of the stratifier */
	if (runtime)
		json_set_int(val, "runtime", runtime);

	ck_rlock(&cdata->lock);
	objects = HASH_COUNT(cdata->clients);
	memsize = SAFE_HASH_OVERHEAD(cdata->clients) + sizeof(client_instance_t) * objects;
	generated = cdata->clients_generated;
	ck_runlock(&cdata->lock);

	JSON_CPACK(subval, "{si,si,si}", "count", objects, "memory", memsize, "generated", generated);
	json_set_object(val, "clients", subval);

	ck_rlock(&cdata->lock);
	DL_COUNT2(cdata->dead_clients, client, objects, dead_next);
	generated = cdata->dead_generated;
	ck_runlock(&cdata->lock);

	memsize = objects * sizeof(client_instance_t);
	JSON_CPACK(subval, "{si,si,si}", "count", objects, "memory", memsize, "generated", generated);
	json_set_object(val, "dead", subval);

	objects = 0;
	memsize = 0;

	mutex_lock(&cdata->sender_lock);
	DL_FOREACH(cdata->sender_sends, send) {
		objects++;
		memsize += sizeof(sender_send_t) + send->len + 1;
	}
	JSON_CPACK(subval, "{si,si,si}", "count", objects, "memory", memsize, "generated", cdata->sends_generated);
	json_set_object(val, "sends", subval);

	JSON_CPACK(subval, "{si,si,si}", "count", cdata->sends_queued, "memory", cdata->sends_size, "generated", cdata->sends_delayed);
	mutex_unlock(&cdata->sender_lock);

	json_set_object(val, "delays", subval);

	buf = json_dumps(val, JSON_NO_UTF8 | JSON_PRESERVE_ORDER);
	json_decref(val);
	if (runtime)
		LOGNOTICE("Passthrough:%s", buf);
	else
		LOGNOTICE("Connector stats: %s", buf);
	return buf;
}

void connector_send_fd(const int fdno, const int sockd)
{
	cdata_t *cdata = ckpool.cdata;

	if (fdno > -1 && fdno < ckpool.serverurls)
		send_fd(cdata->serverfd[fdno], sockd);
	else
		LOGWARNING("Connector asked to send invalid fd %d", fdno);
}

static void connector_loop(proc_instance_t *pi, cdata_t *cdata)
{
	unix_msg_t *umsg = NULL;
	time_t last_stats;
	int64_t client_id;
	int ret = 0;
	char *buf;

	last_stats = cdata->start_time;

retry:
	if (ckpool.passthrough) {
		time_t diff = time(NULL);

		if (diff - last_stats >= 60) {
			last_stats = diff;
			diff -= cdata->start_time;
			buf = connector_stats(cdata, diff);
			dealloc(buf);
		}
	}

	if (umsg) {
		Close(umsg->sockd);
		free(umsg->buf);
		dealloc(umsg);
	}

	do {
		umsg = get_unix_msg(pi);
	} while (!umsg);

	buf = umsg->buf;
	LOGDEBUG("Connector received message: %s", buf);
	/* The bulk of the messages will be json messages to send to clients
	 * so look for them first. */
	if (likely(buf[0] == '{')) {
		yyjson_doc *sdoc = yyjson_read(buf, strlen(buf), YYJSON_READ_STOP_WHEN_DONE);

		if (likely(sdoc)) {
			yyjson_mut_doc *doc = yyjson_doc_mut_copy(sdoc, &ckyyalc);
			yyjson_doc_free(sdoc);
			ckmsgq_add(cdata->cympq, doc);
		}
	} else if (cmdmatch(buf, "dropclient")) {
		client_instance_t *client;

		ret = sscanf(buf, "dropclient=%"PRId64, &client_id);
		if (ret < 0) {
			LOGDEBUG("Connector failed to parse dropclient command: %s", buf);
			goto retry;
		}
		/* A passthrough client */
		if (subclient(client_id)) {
			drop_passthrough_client(cdata, client_id);
			goto retry;
		}
		client = ref_client_by_id(cdata, client_id);
		if (unlikely(!client)) {
			LOGINFO("Connector failed to find client id %"PRId64" to drop", client_id);
			goto retry;
		}
		ret = invalidate_client(cdata, client);
		dec_instance_ref(cdata, client);
		if (ret >= 0)
			LOGINFO("Connector dropped client id: %"PRId64, client_id);
	} else if (cmdmatch(buf, "testclient")) {
		ret = sscanf(buf, "testclient=%"PRId64, &client_id);
		if (unlikely(ret < 0)) {
			LOGDEBUG("Connector failed to parse testclient command: %s", buf);
			goto retry;
		}
		if (client_exists(cdata, client_id))
			goto retry;
		LOGINFO("Connector detected non-existent client id: %"PRId64, client_id);
		stratifier_drop_id(client_id);
	} else if (cmdmatch(buf, "ping")) {
		LOGDEBUG("Connector received ping request");
		send_unix_msg(umsg->sockd, "pong");
	} else if (cmdmatch(buf, "accept")) {
		LOGDEBUG("Connector received accept signal");
		cdata->accept = true;
	} else if (cmdmatch(buf, "reject")) {
		LOGDEBUG("Connector received reject signal");
		cdata->accept = false;
		if (ckpool.passthrough)
			drop_all_clients(cdata);
	} else if (cmdmatch(buf, "stats")) {
		char *msg;

		LOGDEBUG("Connector received stats request");
		msg = connector_stats(cdata, 0);
		send_unix_msg(umsg->sockd, msg);
	} else if (cmdmatch(buf, "loglevel")) {
		sscanf(buf, "loglevel=%d", &ckpool.loglevel);
	} else if (cmdmatch(buf, "passthrough")) {
		client_instance_t *client;

		ret = sscanf(buf, "passthrough=%"PRId64, &client_id);
		if (ret < 0) {
			LOGDEBUG("Connector failed to parse passthrough command: %s", buf);
			goto retry;
		}
		client = ref_client_by_id(cdata, client_id);
		if (unlikely(!client)) {
			LOGINFO("Connector failed to find client id %"PRId64" to pass through", client_id);
			goto retry;
		}
		passthrough_client(cdata, client);
		dec_instance_ref(cdata, client);
	} else if (cmdmatch(buf, "getxfd")) {
		int fdno = -1;

		sscanf(buf, "getxfd%d", &fdno);
		if (fdno > -1 && fdno < ckpool.serverurls)
			send_fd(cdata->serverfd[fdno], umsg->sockd);
	} else if (cmdmatch(buf, "remote")) {
		int64_t client = -1;

		sscanf(buf, "remote=%ld", &client);
		add_remote_client(cdata, client);
	} else
		LOGWARNING("Unhandled connector message: %s", buf);
	goto retry;
}

void *connector(void *arg)
{
	proc_instance_t *pi = (proc_instance_t *)arg;
	cdata_t *cdata = ckzalloc(sizeof(cdata_t));
	char newurl[INET6_ADDRSTRLEN], newport[8];
	int threads, sockd, i, tries = 0, ret;
	const int on = 1;

	rename_proc(pi->processname);
	LOGWARNING("%s connector starting", ckpool.name);
	ckpool.cdata = cdata;

	if (!ckpool.serverurls) {
		/* No serverurls have been specified. Bind to all interfaces
		 * on default sockets. */
		struct sockaddr_in serv_addr;

		cdata->serverfd = ckalloc(sizeof(int *));

		sockd = socket(AF_INET, SOCK_STREAM, 0);
		if (sockd < 0) {
			LOGERR("Connector failed to open socket");
			goto out;
		}
		setsockopt(sockd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
		memset(&serv_addr, 0, sizeof(serv_addr));
		serv_addr.sin_family = AF_INET;
		serv_addr.sin_addr.s_addr = htonl(INADDR_ANY);
		serv_addr.sin_port = htons(ckpool.proxy ? 3334 : 3333);
		do {
			ret = bind(sockd, (struct sockaddr*)&serv_addr, sizeof(serv_addr));

			if (!ret)
				break;
			LOGWARNING("Connector failed to bind to socket, retrying in 5s");
			sleep(5);
		} while (++tries < 25);
		if (ret < 0) {
			LOGERR("Connector failed to bind to socket for 2 minutes");
			Close(sockd);
			goto out;
		}
		/* Set listen backlog to larger than SOMAXCONN in case the
		 * system configuration supports it */
		if (listen(sockd, 8192) < 0) {
			LOGERR("Connector failed to listen on socket");
			Close(sockd);
			goto out;
		}
		cdata->serverfd[0] = sockd;
		url_from_socket(sockd, newurl, newport);
		ASPRINTF(&ckpool.serverurl[0], "%s:%s", newurl, newport);
		ckpool.serverurls = 1;
	} else {
		cdata->serverfd = ckalloc(sizeof(int *) * ckpool.serverurls);

		for (i = 0; i < ckpool.serverurls; i++) {
			char oldurl[INET6_ADDRSTRLEN], oldport[8];
			char *serverurl = ckpool.serverurl[i];
			int port;

			if (!url_from_serverurl(serverurl, newurl, newport)) {
				LOGWARNING("Failed to extract resolved url from %s", serverurl);
				goto out;
			}
			port = atoi(newport);
			/* All high port servers are treated as highdiff ports */
			if (port > 4000) {
				LOGNOTICE("Highdiff server %s", serverurl);
				ckpool.server_highdiff[i] = true;
			}
			sockd = ckpool.oldconnfd[i];
			if (url_from_socket(sockd, oldurl, oldport)) {
				if (strcmp(newurl, oldurl) || strcmp(newport, oldport)) {
					LOGWARNING("Handed over socket url %s:%s does not match config %s:%s, creating new socket",
						   oldurl, oldport, newurl, newport);
					Close(sockd);
				}
			}

			do {
				if (sockd > 0)
					break;
				sockd = bind_socket(newurl, newport);
				if (sockd > 0)
					break;
				LOGWARNING("Connector failed to bind to socket, retrying in 5s");
				sleep(5);
			} while (++tries < 25);

			if (sockd < 0) {
				LOGERR("Connector failed to bind to socket for 2 minutes");
				goto out;
			}
			if (listen(sockd, 8192) < 0) {
				LOGERR("Connector failed to listen on socket");
				Close(sockd);
				goto out;
			}
			cdata->serverfd[i] = sockd;
		}
	}

	if (tries)
		LOGWARNING("Connector successfully bound to socket");

	cdata->cympq = create_ckmsgq("cympq", &client_yymessage_processor);

	if (ckpool.remote && !setup_upstream(cdata))
		goto out;

	cklock_init(&cdata->lock);
	cdata->pi = pi;
	cdata->nfds = 0;
	/* Set the client id to the highest serverurl count to distinguish
	 * them from the server fds in epoll. */
	cdata->client_ids = ckpool.serverurls;
	mutex_init(&cdata->sender_lock);
	cond_init(&cdata->sender_cond);
	create_pthread(&cdata->pth_sender, sender, cdata);
	threads = sysconf(_SC_NPROCESSORS_ONLN) / 2 ? : 1;
	cdata->cevents = create_ckmsgqs("cevent", &client_event_processor, threads);
	create_pthread(&cdata->pth_receiver, receiver, cdata);
	cdata->start_time = time(NULL);

	ckpool.connector_ready = true;
	LOGWARNING("%s connector ready", ckpool.name);

	connector_loop(pi, cdata);
out:
	/* We should never get here unless there's a fatal error */
	LOGEMERG("Connector failure, shutting down");
	exit(1);
	return NULL;
}
