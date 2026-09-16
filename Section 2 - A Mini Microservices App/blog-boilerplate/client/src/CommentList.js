import React, { useEffect, useState } from 'react';
import axios from "axios";

const CommentList = ({ comments }) => {
    //Now we are not directly calling the comment service to get comments but we are calling query service to post and comments and passing the comments to this component as props from the PostList Component.
    // const [comments, setComments] = useState([]);
    // const fetchComments = async () => {
    //     const res = await axios.get(`http://localhost:4001/posts/${postId}/comments`);
    //     setComments(res.data);
    // }
    // useEffect(() => { fetchComments() }, [])
    const renderedComments = comments.map(comment => {
        let content;
        if (comment.status === "approved") {
            content = comment.content;
        }
        if (comment.status === "pending") {
            content = <i>Awaiting moderation</i>;
        }
        if (comment.status === "rejected") {
            content = <i style={{ textDecorationLine: "line-through" }}>This comment has been rejected</i>;
        }
        return <li key={comment.id}>{content}</li>
    })
    return (
        <div>
            {/* <p>{JSON.stringify(comments)}</p> */}
            <ul>
                {renderedComments}
            </ul>
        </div>
    );
}

export default CommentList;
